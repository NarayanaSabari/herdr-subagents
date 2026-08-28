/**
 * Live subagent tracking.
 *
 * Completion is detected from herdr's `pane.agent_status_changed` event
 * stream rather than by polling. Herdr already classifies each pane occupant
 * as idle/working/blocked/done, so there is nothing to infer from screen
 * contents - a real advantage over screen-scraping multiplexer integrations.
 *
 * The state machine is deliberately small:
 *
 *   starting ──> working ──> finished        (normal completion)
 *                   │
 *                   └──────> blocked         (herdr saw an approval prompt)
 *
 * `working` is required before `finished`. Herdr reports the freshly started
 * agent as `idle` while it waits for input, so treating the first idle as
 * completion would finish every subagent instantly with an empty result.
 */

import { watchPane } from "./events.ts";

export type SubagentState = "starting" | "working" | "blocked" | "finished" | "failed";

export interface Subagent {
  /** Unique display name; also the herdr agent target. */
  name: string;
  /** Agent definition used. */
  agent: string;
  /** Task text as given by the caller. */
  task: string;
  paneId: string;
  /** Pane this subagent was spawned from, for column bookkeeping. */
  parentPaneId: string;
  sessionDir: string;
  sessionId: string;
  state: SubagentState;
  startedAt: number;
  finishedAt?: number;
  /** Final assistant message, once finished. */
  result?: string;
  /** Failure detail, when state is "failed". */
  error?: string;
  /** Resolves when this subagent reaches a terminal state. */
  done: Promise<Subagent>;
  /** Internal: settles `done`. */
  settle?: (s: Subagent) => void;
}

type Listener = (s: Subagent) => void;

export class SubagentRegistry {
  private readonly agents = new Map<string, Subagent>();
  private readonly listeners = new Set<Listener>();
  private readonly watchers = new Map<string, { stop: () => void }>();

  /**
   * Decides whether a subagent left a usable result behind.
   *
   * Injected so the registry stays free of session-file parsing, and so tests
   * can drive the exit-versus-completion race directly.
   */
  hasResult?: (s: Subagent) => boolean;

  /** Register a freshly spawned subagent and begin watching its pane. */
  add(s: Subagent): void {
    this.agents.set(s.name, s);
    this.watch(s);
  }

  get(name: string): Subagent | undefined {
    return this.agents.get(name);
  }

  all(): Subagent[] {
    return [...this.agents.values()];
  }

  running(): Subagent[] {
    return this.all().filter((s) => s.state === "starting" || s.state === "working" || s.state === "blocked");
  }

  /** Finished subagents, terminal either way. */
  finished(): Subagent[] {
    return this.all().filter((s) => s.state === "finished" || s.state === "failed");
  }

  onChange(fn: Listener): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private emit(s: Subagent): void {
    for (const fn of this.listeners) {
      try {
        fn(s);
      } catch {
        // A broken listener must not stall the state machine.
      }
    }
  }

  /** Give a subagent a unique name; duplicates get -2, -3, ... */
  uniqueName(base: string): string {
    if (!this.agents.has(base)) return base;
    for (let i = 2; i < 1000; i++) {
      const candidate = `${base}-${i}`;
      if (!this.agents.has(candidate)) return candidate;
    }
    return `${base}-${Date.now()}`;
  }

  transition(name: string, state: SubagentState, extra?: Partial<Subagent>): void {
    const s = this.agents.get(name);
    if (!s) return;
    if (s.state === "finished" || s.state === "failed") return; // terminal
    s.state = state;
    Object.assign(s, extra ?? {});
    if (state === "finished" || state === "failed") {
      s.finishedAt = Date.now();
      this.watchers.get(name)?.stop();
      this.watchers.delete(name);
      s.settle?.(s);
    }
    this.emit(s);
  }

  /**
   * Subscribe to one subagent's pane and drive its state machine.
   *
   * The watcher closes itself as soon as the agent reaches a terminal state,
   * so no subscription outlives the work it was tracking.
   */
  private watch(s: Subagent): void {
    const w = watchPane(
      s.paneId,
      ({ event, data }) => {
        this.handleEvent(event, data);
        const cur = this.agents.get(s.name);
        return cur?.state === "finished" || cur?.state === "failed";
      },
      (err) => {
        // Losing the stream must not strand the caller waiting forever.
        this.transition(s.name, "failed", {
          error: `lost herdr event stream: ${err.message}`,
        });
      },
    );
    this.watchers.set(s.name, w);
  }

  /**
   * Feed a decoded herdr event into the state machine.
   *
   * Ordering note: `pane.exited` and the final `agent_status_changed(idle)`
   * are separate events and herdr publishes no guarantee about their relative
   * order. Treating an exit as failure unconditionally would therefore lose
   * the result of a subagent that finished correctly and then closed - which
   * is exactly what happens once panes auto-close on completion.
   *
   * So an exit is only a failure when the child left no readable result
   * behind. The session file is the arbiter: it is written before the process
   * exits, so if a final assistant message exists the work did complete,
   * whichever event we happen to see first.
   */
  handleEvent(event: string, data: Record<string, unknown>): void {
    const paneId = data.pane_id as string | undefined;
    if (!paneId) return;
    const s = this.all().find((a) => a.paneId === paneId);
    if (!s) return;

    if (event === "pane.exited" || event === "pane.closed") {
      if (s.state === "finished" || s.state === "failed") return;
      if (this.hasResult?.(s)) this.transition(s.name, "finished");
      else
        this.transition(s.name, "failed", {
          error: "pane exited before the agent produced a result",
        });
      return;
    }

    if (event !== "pane.agent_status_changed") return;
    const status = data.agent_status as string | undefined;

    if (status === "working") {
      if (s.state === "starting" || s.state === "blocked") this.transition(s.name, "working");
      return;
    }
    if (status === "blocked") {
      this.transition(s.name, "blocked");
      return;
    }
    // Only a settle that follows observed work counts as completion; see the
    // module docstring.
    if ((status === "idle" || status === "done") && s.state === "working") {
      this.transition(s.name, "finished");
    }
  }

  /** Stop watching. Panes are left alone: the user may still be reading them. */
  dispose(): void {
    for (const w of this.watchers.values()) w.stop();
    this.watchers.clear();
    this.listeners.clear();
  }
}
