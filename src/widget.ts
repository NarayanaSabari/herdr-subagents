/**
 * Live status widget, rendered above the editor while subagents run.
 *
 * Without it a blocking `subagent` call looks like a hang: the main agent
 * stops, and nothing on screen says why or for how long. The widget makes the
 * wait legible.
 *
 *     ╭─ Subagents ──────────────────────── 2 running ─╮
 *     │ ● 00:23  scout-ops (scout)          working    │
 *     │ ◐ 00:45  explore-api (explore)      starting…  │
 *     ╰────────────────────────────────────────────────╯
 *
 * Uses `ctx.ui.setWidget(key, lines, { placement: "aboveEditor" })`, which
 * takes a plain string array, so no TUI component plumbing is needed.
 */

import type { Subagent, SubagentState } from "./registry.ts";

const ACCENT = "\x1b[38;5;110m";
const DIM = "\x1b[2m";
const GREEN = "\x1b[32m";
const YELLOW = "\x1b[33m";
const RED = "\x1b[31m";
const RST = "\x1b[0m";

const WIDGET_KEY = "herdr-subagents";

/** Visible width, ignoring ANSI escapes. */
function vw(s: string): number {
  return s.replace(/\x1b\[[0-9;]*m/g, "").length;
}

function icon(state: SubagentState): string {
  switch (state) {
    case "starting":
      return `${DIM}◌${RST}`;
    case "working":
      return `${GREEN}●${RST}`;
    case "blocked":
      return `${YELLOW}◆${RST}`;
    case "failed":
      return `${RED}✗${RST}`;
    default:
      return `${DIM}○${RST}`;
  }
}

function label(state: SubagentState): string {
  switch (state) {
    case "starting":
      return "starting…";
    case "working":
      return "working";
    case "blocked":
      return "BLOCKED - needs input";
    case "finished":
      return "done";
    default:
      return "failed";
  }
}

function elapsed(from: number, to = Date.now()): string {
  const secs = Math.max(0, Math.floor((to - from) / 1000));
  const m = String(Math.floor(secs / 60)).padStart(2, "0");
  const s = String(secs % 60).padStart(2, "0");
  return `${m}:${s}`;
}

function top(title: string, info: string, width: number): string {
  if (width <= 2) return `${ACCENT}╭╮${RST}`;
  const inner = width - 2;
  const left = `─ ${title} `;
  const right = ` ${info} ─`;
  const fill = "─".repeat(Math.max(0, inner - left.length - right.length));
  return `${ACCENT}╭${`${left}${fill}${right}`.slice(0, inner).padEnd(inner, "─")}╮${RST}`;
}

function bottom(width: number): string {
  if (width <= 2) return `${ACCENT}╰╯${RST}`;
  return `${ACCENT}╰${"─".repeat(width - 2)}╯${RST}`;
}

function row(left: string, right: string, width: number): string {
  const inner = Math.max(0, width - 2);
  const budget = inner - vw(right) - 1;
  let l = left;
  if (vw(l) > budget) {
    // Trim by visible width; these strings only carry colour at the edges.
    while (vw(l) > Math.max(0, budget - 1) && l.length) l = l.slice(0, -1);
    l += "…";
  }
  const gap = " ".repeat(Math.max(1, inner - vw(l) - vw(right)));
  return `${ACCENT}│${RST}${l}${gap}${right}${ACCENT}│${RST}`;
}

/** Render the widget, or undefined when nothing is running. */
export function renderWidget(agents: Subagent[], width = 78): string[] | undefined {
  const live = agents.filter((a) => a.state !== "finished" && a.state !== "failed");
  if (live.length === 0) return undefined;

  const w = Math.max(30, Math.min(width, 120));
  const lines = [top("Subagents", `${live.length} running`, w)];

  for (const a of live) {
    const left = ` ${icon(a.state)} ${DIM}${elapsed(a.startedAt)}${RST}  ${a.name} ${DIM}(${a.agent})${RST}`;
    const right = `${a.state === "blocked" ? YELLOW : DIM}${label(a.state)}${RST} `;
    lines.push(row(left, right, w));
  }

  lines.push(bottom(w));
  return lines;
}

/** Minimal shape we need from ExtensionContext, so this stays testable. */
interface WidgetHost {
  hasUI: boolean;
  ui: {
    setWidget(
      key: string,
      content: string[] | undefined,
      options?: { placement?: "aboveEditor" | "belowEditor" },
    ): void;
  };
}

/**
 * Keeps the widget in sync with the registry.
 *
 * A 1s repaint keeps the elapsed timers moving; herdr's status events only
 * fire on transitions, so event-driven repaints alone would freeze the clock.
 * The interval only runs while something is live.
 */
export class WidgetController {
  private timer?: ReturnType<typeof setInterval>;
  private host?: WidgetHost;

  attach(host: WidgetHost): void {
    this.host = host;
  }

  update(agents: Subagent[]): void {
    const host = this.host;
    if (!host?.hasUI) return;

    const lines = renderWidget(agents);
    try {
      host.ui.setWidget(WIDGET_KEY, lines, { placement: "aboveEditor" });
    } catch {
      // A widget failure must never break a spawn.
    }

    if (lines && !this.timer) {
      this.timer = setInterval(() => this.update(agents), 1000);
      this.timer.unref?.();
    } else if (!lines) {
      this.stop();
    }
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  dispose(): void {
    this.stop();
    try {
      this.host?.ui.setWidget(WIDGET_KEY, undefined);
    } catch {
      /* shutting down anyway */
    }
    this.host = undefined;
  }
}
