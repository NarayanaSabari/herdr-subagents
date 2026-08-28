/**
 * herdr-subagents: subagents for pi, running in herdr panes.
 *
 * `subagent()` blocks until the child finishes and returns its report as the
 * tool result. Several calls in one assistant turn run concurrently, so the
 * model can fan out and still cannot conclude before every result is in.
 *
 * An earlier version returned immediately and delivered results later through
 * `pi.sendMessage`. In real use the main agent simply answered first, while
 * three subagents were still working, so its answer was written without the
 * evidence it had asked for. Blocking removes that failure mode by
 * construction rather than by asking the model to remember to wait.
 *
 * Why herdr rather than a terminal multiplexer: herdr already classifies every
 * pane occupant as idle / working / blocked / done and pushes those
 * transitions over its socket, so completion is an event subscription rather
 * than screen-scraping, and `blocked` is a real signal that a child is stuck
 * on an approval prompt.
 */

import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { Type } from "typebox";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

import { loadAgents, type AgentDef } from "./agents.ts";
import { registerCommands } from "./commands.ts";
import { adoptPiPaths, piPaths } from "./pi-paths.ts";
import {
  closePane,
  getAgent,
  focusAgent,
  insideHerdr,
  promptAgent,
  sendKeys,
  startAgent,
  HerdrError,
} from "./herdr.ts";
import { createSubagentPane, releaseSubagentPane } from "./layout.ts";
import { PanelState } from "./panel.ts";
import { SubagentRegistry, type Subagent } from "./registry.ts";
import { findSessionFile, lastAssistantMessage, truncateResult } from "./session.ts";
import { WidgetController } from "./widget.ts";

/**
 * Extensions the child keeps despite `--no-extensions`.
 *
 * Not optional polish. Measured on 2026-08-28: a child started with a bare
 * `--no-extensions` loses the Anthropic subscription fix and dies on its first
 * turn with `400 "You're out of extra usage"`. Guards are re-added for the
 * same reason they exist in the parent - a subagent with `bash` must not run
 * `git reset --hard` unchallenged.
 *
 * Resolved from pi's own agent directory via `getAgentDir()`, which honours
 * `PI_CODING_AGENT_DIR`, rather than a hardcoded `~/.pi` that would silently
 * read the default config even when pi is running against another one.
 * Missing paths are dropped. Override with `HERDR_SUBAGENT_EXTENSIONS`, a
 * colon-separated list.
 */
const PI_EXTENSIONS_DIR = () => join(piPaths().agentDir, "extensions");

function requiredExtensions(): string[] {
  const dir = PI_EXTENSIONS_DIR();
  const paths = process.env.HERDR_SUBAGENT_EXTENSIONS
    ? process.env.HERDR_SUBAGENT_EXTENSIONS.split(":").filter(Boolean)
    : [join(dir, "anthropic-subscription-fix.ts"), join(dir, "guards")];
  return paths.filter((p) => existsSync(p));
}

/** Where child transcripts are written, so results can be read back. */
const SESSION_ROOT = () => join(piPaths().agentDir, "subagent-sessions");

/** Hard ceiling on a single subagent, so a wedged child cannot hang the turn. */
const SUBAGENT_TIMEOUT_MS = Number(process.env.HERDR_SUBAGENT_TIMEOUT_MS ?? 15 * 60 * 1000);

const SUMMARY_INSTRUCTION = `

---
You are running as an autonomous subagent. Your FINAL message is the entire
report your caller receives - they cannot see your pane, your tool calls, or
your reasoning. Write it as a self-contained answer: what you found, where
(file:line), and what you concluded. No preamble, no "let me know if".`;

function slug(s: string): string {
  return (
    s
      .toLowerCase()
      .replace(/[^a-z0-9-]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 24) || "subagent"
  );
}

function msg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function errorResult(text: string) {
  return { content: [{ type: "text" as const, text }], isError: true };
}

export default async function (pi: ExtensionAPI) {
  // Upgrade to pi's real path helpers before anything resolves a path.
  await adoptPiPaths();

  const registry = new SubagentRegistry();
  const widget = new WidgetController();
  const panel = new PanelState();

  /**
   * Whether a subagent left a readable result behind.
   *
   * The registry consults this to resolve the exit-versus-completion race:
   * `pane.exited` and the final `idle` status are independent events with no
   * documented ordering, and panes now close on success, so an exit alone
   * cannot mean failure.
   */
  registry.hasResult = (s: Subagent) => {
    const f = findSessionFile(s.sessionDir, s.sessionId);
    return Boolean(f && lastAssistantMessage(f));
  };

  registry.onChange(() => widget.update());

  /**
   * Bind the widget and the panel to a live UI context.
   *
   * Called from `session_start` and again on the first spawn: a tool call can
   * arrive against a context the extension has not seen `session_start` for,
   * and an unattached widget silently renders nothing.
   */
  function attachUI(ctx: unknown): void {
    const host = ctx as {
      hasUI?: boolean;
      ui?: {
        onTerminalInput?(h: (d: string) => unknown): () => void;
        getEditorText?(): string;
        notify?(m: string, t?: string): void;
      };
    };
    widget.attach(
      ctx as unknown as Parameters<typeof widget.attach>[0],
      () => registry.all(),
      () => panel.selection(widget.rows()),
    );
    // Wired here rather than only in `session_start`: a tool call can be the
    // first thing that attaches a context, and with notify unwired every
    // failure toast from the panel would go to the no-op default - a failed
    // stop would be silently invisible.
    const ui = host?.ui;
    if (ui?.notify) {
      notifyUI = (m, k = "info") => {
        try {
          ui.notify?.(m, k);
        } catch {
          // A missed toast must never break key handling.
        }
      };
    }
    bindKeys(host);
  }

  /** Unsubscribes the raw-input listener, so re-attaching cannot double-bind. */
  let unbindKeys: (() => void) | undefined;

  /**
   * Claim the keys the panel needs, and only those.
   *
   * Everything is gated on there being a live subagent AND an empty editor, so
   * in an ordinary session this handler passes every key straight through. The
   * listener stays registered for the session because pi offers no way to
   * re-register cheaply, but it is inert whenever the panel has no rows.
   */
  function bindKeys(host: {
    hasUI?: boolean;
    ui?: { onTerminalInput?(h: (d: string) => unknown): () => void; getEditorText?(): string };
  }): void {
    if (!host?.hasUI || !host.ui?.onTerminalInput) return;
    // Rebind rather than skip. Skipping would leave the handler bound to a
    // previous context's editor if `session_start` ever fires twice without an
    // intervening shutdown, and `getEditorText()` on a dead editor could
    // return "" forever - the panel would then steal keys from a live editor
    // it cannot see.
    unbindKeys?.();
    unbindKeys = host.ui.onTerminalInput((data: string) => {
      const rows = widget.rows();
      // `getEditorText` is the guard that keeps arrows working while typing.
      // If pi ever stops providing it, fail closed and take no keys at all.
      const text = host.ui?.getEditorText?.();
      const empty = text === "";
      const { consume, action } = panel.handle(data, rows, empty);

      if (action.kind === "open") void openSubagent(action.name);
      else if (action.kind === "stop") void stopSubagent(action.name);
      if (consume) widget.update();

      return consume ? { consume: true } : undefined;
    }) as () => void;
  }

  /** Enter: hand the keyboard to the child's pane. */
  async function openSubagent(name: string): Promise<void> {
    try {
      await focusAgent(name);
    } catch (err) {
      // The pane may have closed in the moment between paint and keypress.
      notifyUI(`Could not open ${name}: ${(err as Error).message}`, "warning");
    }
  }

  /**
   * `x`: stop a subagent the user no longer wants.
   *
   * Interrupt rather than kill the pane, so the child unwinds and flushes its
   * session file and a partial result stays readable; closing the pane
   * outright would race that write and lose it.
   *
   * The key is `esc`, not `ctrl+c`. Measured on 2026-08-28: `ctrl+c` sent to a
   * working pi child does nothing at all - the agent stayed `working` through
   * a full sleep - while `esc` cancels the turn immediately. Ctrl+C is pi's
   * quit-on-empty-prompt chord, not its interrupt.
   *
   * `cancelled` is recorded before the key goes out so the widget stops
   * claiming the agent is working the moment the user asks for it to stop.
   */
  async function stopSubagent(name: string): Promise<void> {
    const s = registry.get(name);
    if (!s || s.state === "finished" || s.state === "failed") return;
    cancelled.add(name);
    try {
      await sendKeys(name, "esc");
      notifyUI(`Stopped subagent ${name}`);
      widget.update();
    } catch (err) {
      cancelled.delete(name);
      notifyUI(`Could not stop ${name}: ${(err as Error).message}`, "warning");
    }
  }

  /**
   * Subagents the user stopped from the panel.
   *
   * Without this the tool result reads "finished but produced no readable
   * result", which describes a malfunction rather than the deliberate act it
   * was. The main agent needs to know the difference: one is worth retrying,
   * the other means stop.
   */
  const cancelled = new Set<string>();

  /** Best-effort toast; never throws into a key handler. */
  let notifyUI: (msg: string, kind?: "info" | "warning" | "error") => void = () => {};

  /**
   * Tear down a finished subagent's pane.
   *
   * Both outcomes close, including failures, so the column shrinks and the
   * main pane reclaims its space. The result and any error text are read
   * before this runs, so closing never discards the evidence.
   */
  async function reclaim(s: Subagent): Promise<void> {
    try {
      await closePane(s.paneId);
    } catch {
      // Already gone, or the user closed it. Either way, nothing to do.
    }
    releaseSubagentPane(s.parentPaneId, s.paneId);
  }

  pi.registerTool({
    name: "subagent",
    label: "Run subagent",
    description:
      "Run a task in an autonomous subagent with its own context and tool sandbox, " +
      "in a dedicated herdr pane. Blocks until the subagent finishes and returns its " +
      "report. Issue several subagent calls in the same turn to run them in parallel. " +
      "Use subagents_list to see available agents.",
    promptSnippet: "Run a task in a sandboxed subagent and get its report back",
    promptGuidelines: [
      "Use subagent for self-contained investigation whose intermediate output you would never re-read - recon across unfamiliar code, or several independent questions at once.",
      "A subagent cannot see this conversation. The task string is everything it gets, so make it self-contained and say what a good answer looks like.",
      "To parallelise, issue several subagent calls in a single turn rather than one after another; they run concurrently and all must return before the turn ends.",
      "Treat a subagent's report as evidence, not fact. Verify any claim you are about to act on.",
    ],
    parameters: Type.Object({
      agent: Type.String({
        description: "Agent definition to run. Use subagents_list to see what exists.",
      }),
      task: Type.String({
        description:
          "Self-contained task prompt. The subagent sees only this, not the current conversation.",
      }),
      name: Type.Optional(
        Type.String({
          description: "Display name for the pane. Defaults to the agent name; duplicates get -2, -3.",
        }),
      ),
      cwd: Type.Optional(
        Type.String({ description: "Working directory. Defaults to the current one." }),
      ),
    }),

    // Concurrency is the point: several subagent calls in one assistant turn
    // should run at once. pi's default is already parallel (measured: three
    // 3-second probes returned identical start and end timestamps), but the
    // default is a setting and this tool's usefulness depends on it, so pin it
    // rather than inherit it.
    executionMode: "parallel",

    async execute(_id, params, signal, onUpdate, ctx: ExtensionContext) {
      if (!insideHerdr()) {
        return errorResult(
          "Not running inside herdr (HERDR_ENV is unset), so there is no pane to split. " +
            "Start pi inside a herdr session and try again.",
        );
      }
      const parentPaneId = process.env.HERDR_PANE_ID;
      if (!parentPaneId) {
        return errorResult("HERDR_PANE_ID is unset, so the caller's pane cannot be located.");
      }

      const { agents, errors } = loadAgents(ctx.cwd);
      const def: AgentDef | undefined = agents.get(params.agent);
      if (!def) {
        const known = [...agents.keys()].sort().join(", ") || "(none)";
        return errorResult(
          `Unknown agent "${params.agent}". Available: ${known}` +
            (errors.length ? `\n\nDefinitions that failed to load:\n${errors.join("\n")}` : ""),
        );
      }

      attachUI(ctx);

      const name = registry.uniqueName(params.name ? slug(params.name) : def.name);
      const cwd = params.cwd ?? ctx.cwd;
      const sessionDir = join(SESSION_ROOT(), name);
      const sessionId = `${name}-${Date.now()}`;
      mkdirSync(sessionDir, { recursive: true });

      // The system prompt goes in a FILE, not on the command line. Herdr
      // rejects any agent argument it cannot encode safely for the target
      // shell, and a multi-line value trips that with
      // `invalid_agent_argument`. Every useful agent body is multi-line, and
      // pi's --append-system-prompt accepts "text or file contents", so a path
      // sidesteps the limit and keeps the argument one shell-safe token.
      const promptFile = join(sessionDir, `${sessionId}.system.md`);
      writeFileSync(promptFile, def.body + SUMMARY_INSTRUCTION, "utf8");

      // Default-deny sandbox: no discovered extensions, an explicit tool
      // allowlist, and only the extensions we deliberately add back.
      const piArgs = [
        "--session-dir", sessionDir,
        "--session-id", sessionId,
        "--no-extensions",
        "--tools", def.tools.join(","),
        "--append-system-prompt", promptFile,
      ];
      for (const ext of requiredExtensions()) piArgs.push("-e", ext);
      if (def.model) piArgs.push("--model", def.model);
      if (def.thinking) piArgs.push("--thinking", def.thinking);

      let paneId: string;
      try {
        paneId = await createSubagentPane({
          parentPaneId,
          cwd,
          env: { HERDR_SUBAGENT: name, HERDR_SUBAGENT_PARENT: parentPaneId },
        });
      } catch (err) {
        return errorResult(`Could not create a pane for the subagent: ${msg(err)}`);
      }

      try {
        await startAgent({ name, paneId, piArgs, timeoutMs: 60_000 });
      } catch (err) {
        try {
          await closePane(paneId);
        } catch {
          /* best effort */
        }
        releaseSubagentPane(parentPaneId, paneId);
        return errorResult(`Could not start pi in pane ${paneId}: ${msg(err)}`);
      }

      let settle!: (s: Subagent) => void;
      const done = new Promise<Subagent>((resolve) => {
        settle = resolve;
      });

      const sub: Subagent = {
        name,
        agent: def.name,
        task: params.task,
        paneId,
        parentPaneId,
        sessionDir,
        sessionId,
        state: "starting",
        startedAt: Date.now(),
        done,
        settle,
      };
      registry.add(sub);
      widget.update();

      onUpdate?.({
        content: [{ type: "text", text: `Running ${name} (${def.name}) in pane ${paneId}…\n` }],
      });

      try {
        await promptAgent({ target: name, text: params.task, wait: false });
      } catch (err) {
        registry.transition(name, "failed", { error: `prompt failed: ${msg(err)}` });
        await reclaim(sub);
        return errorResult(`Started ${name} but could not prompt it: ${msg(err)}`);
      }

      // Block until the child settles, the caller aborts, or the ceiling hits.
      const timeout = new Promise<"timeout">((r) =>
        setTimeout(() => r("timeout"), SUBAGENT_TIMEOUT_MS).unref?.(),
      );
      const aborted = new Promise<"aborted">((r) => {
        if (signal) signal.addEventListener("abort", () => r("aborted"), { once: true });
      });

      const outcome = await Promise.race([done, timeout, aborted]);
      widget.update();

      // Checked before the timeout branch: a user stop that lands inside the
      // abort window would otherwise be reported as "did not finish within 15
      // minutes", which is exactly the misleading-malfunction framing this
      // feature exists to remove.
      if (cancelled.has(name)) {
        cancelled.delete(name);
        const partial = registry.hasResult?.(sub)
          ? lastAssistantMessage(findSessionFile(sessionDir, sessionId)!)
          : undefined;
        registry.transition(name, "failed", { error: "stopped by the user" });
        await reclaim(sub);
        widget.update();
        return errorResult(
          `Subagent ${name} was stopped by the user.` +
            (partial ? `\n\nPartial output before it stopped:\n${truncateResult(partial)}` : "") +
            `\n\nDo not restart it unless asked.`,
        );
      }

      if (outcome === "timeout" || outcome === "aborted") {
        const why =
          outcome === "timeout"
            ? `did not finish within ${Math.round(SUBAGENT_TIMEOUT_MS / 60000)} minutes`
            : "was cancelled";
        registry.transition(name, "failed", { error: why });
        const partial = registry.hasResult?.(sub)
          ? lastAssistantMessage(findSessionFile(sessionDir, sessionId)!)
          : undefined;
        await reclaim(sub);
        return errorResult(
          `Subagent ${name} ${why}.` +
            (partial ? `\n\nPartial output before it stopped:\n${truncateResult(partial)}` : ""),
        );
      }

      const file = findSessionFile(sessionDir, sessionId);
      const text = file ? lastAssistantMessage(file) : undefined;
      const secs = Math.round(((sub.finishedAt ?? Date.now()) - sub.startedAt) / 1000);

      await reclaim(sub);
      widget.update();

      if (sub.state === "failed" && !text) {
        return errorResult(`Subagent ${name} failed: ${sub.error ?? "unknown error"}`);
      }
      if (!text) {
        return errorResult(
          `Subagent ${name} finished but produced no readable result. Transcript: ${file ?? sessionDir}`,
        );
      }

      return {
        content: [
          {
            type: "text" as const,
            text: `[${name} (${def.name}) finished in ${secs}s]\n\n${truncateResult(text)}`,
          },
        ],
        details: { name, agent: def.name, seconds: secs, transcript: file },
      };
    },
  });

  pi.registerTool({
    name: "subagents_list",
    label: "List subagents",
    description: "List the available subagent definitions and their tool sandboxes.",
    promptSnippet: "List available subagent types",
    parameters: Type.Object({}),
    async execute(_id, _params, _signal, _onUpdate, ctx: ExtensionContext) {
      const { agents, errors } = loadAgents(ctx.cwd);
      const lines: string[] = ["Available agents:"];
      if (agents.size === 0) {
        lines.push(
          "  (none found)",
          "",
          "Agent definitions are .md files in .pi/agents/ or ~/.pi/agent/agents/.",
        );
      }
      for (const a of [...agents.values()].sort((x, y) => x.name.localeCompare(y.name))) {
        lines.push(`  ${a.name} - ${a.description}`);
        lines.push(`      tools: ${a.tools.join(", ")}${a.model ? ` | model: ${a.model}` : ""}`);
      }

      const live = registry.all().filter((s) => s.state !== "finished" && s.state !== "failed");
      if (live.length) {
        lines.push("", "Currently running:");
        for (const s of live) {
          lines.push(`  ${s.name} (${s.agent}) - ${s.state} - pane ${s.paneId}`);
        }
      }
      if (errors.length) {
        lines.push("", "Definitions that failed to load:", ...errors.map((e) => `  ${e}`));
      }

      return { content: [{ type: "text" as const, text: lines.join("\n") }] };
    },
  });

  pi.registerTool({
    name: "subagent_message",
    label: "Message subagent",
    description:
      "Send a follow-up message to a subagent that is still running. Only useful from a " +
      "different turn, since subagent blocks until its child finishes.",
    promptSnippet: "Send a follow-up to a running subagent",
    parameters: Type.Object({
      name: Type.String({ description: "Subagent name." }),
      message: Type.String({ description: "Message to send." }),
    }),
    async execute(_id, params) {
      const s = registry.get(params.name);
      if (!s) {
        const known = registry.all().map((a) => a.name).join(", ") || "(none)";
        return errorResult(`No subagent named "${params.name}". Known: ${known}`);
      }
      if (s.state === "finished" || s.state === "failed") {
        return errorResult(
          `Subagent "${params.name}" has already ${s.state}; its pane is closed. Spawn a new one.`,
        );
      }
      try {
        await promptAgent({ target: s.name, text: params.message, wait: false });
      } catch (err) {
        const code = err instanceof HerdrError ? err.code : undefined;
        if (code === "agent_blocked") {
          return errorResult(
            `Subagent "${params.name}" is blocked on an approval prompt and cannot accept input. ` +
              `Inspect pane ${s.paneId} and ask the user before answering it.`,
          );
        }
        return errorResult(`Could not message "${params.name}": ${msg(err)}`);
      }
      return { content: [{ type: "text" as const, text: `Message delivered to ${params.name}.` }] };
    },
  });

  pi.registerTool({
    name: "subagent_status",
    label: "Subagent status",
    description: "Check a running subagent's live state and its output so far.",
    promptSnippet: "Check a running subagent's state",
    parameters: Type.Object({
      name: Type.String({ description: "Subagent name." }),
    }),
    async execute(_id, params) {
      const s = registry.get(params.name);
      if (!s) {
        const known = registry.all().map((a) => a.name).join(", ") || "(none)";
        return errorResult(`No subagent named "${params.name}". Known: ${known}`);
      }

      let live = "unknown";
      try {
        live = (await getAgent(s.name)).agent_status ?? "unknown";
      } catch {
        /* pane may be gone */
      }
      const file = findSessionFile(s.sessionDir, s.sessionId);
      const partial = file ? lastAssistantMessage(file) : undefined;
      const secs = Math.round(((s.finishedAt ?? Date.now()) - s.startedAt) / 1000);

      return {
        content: [
          {
            type: "text" as const,
            text:
              `${s.name} (${s.agent})\n  tracked: ${s.state}\n  herdr:   ${live}\n` +
              `  pane: ${s.paneId}\n  elapsed: ${secs}s\n` +
              (partial ? `\nLatest output:\n${truncateResult(partial, 4000)}` : "\n(no output yet)"),
          },
        ],
      };
    },
  });

  registerCommands(pi, registry);

  pi.on("session_start", async (_e, ctx) => {
    attachUI(ctx);
    const ui = (ctx as { hasUI?: boolean; ui?: { notify?(m: string, t?: string): void } }).ui;
    if (ui?.notify) notifyUI = (m, k = "info") => {
      try {
        ui.notify?.(m, k);
      } catch {
        // A missed toast must never break key handling.
      }
    };
  });

  pi.on("session_shutdown", async () => {
    unbindKeys?.();
    unbindKeys = undefined;
    widget.dispose();
    registry.dispose();
  });
}
