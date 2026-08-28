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
/** Reverse video: the selected row, readable on any theme. */
const SEL = "\x1b[7m";

const WIDGET_KEY = "herdr-subagents";

/**
 * Width to draw at.
 *
 * pi does not merely clip an over-wide widget - `tui-main-screen` throws
 * "Rendered line N exceeds terminal width" and takes the whole session down,
 * which this repo has already hit once. A hardcoded 78 is therefore a latent
 * crash for anyone in a narrower pane, and subagents make narrow panes the
 * normal case because every spawn splits the window.
 *
 * One column is left spare: pi renders widgets inside a frame, and a widget
 * that exactly fills the terminal can still overflow it by a character.
 */
function terminalWidth(): number {
  const cols = process.stdout?.columns;
  // No floor. A 30-column minimum would still overflow a 20-column terminal,
  // and pi treats that as fatal - so on a very narrow terminal the box must
  // get ugly rather than take the session down with it.
  if (typeof cols === "number" && cols > 0) return Math.min(cols - 1, 120);
  return 78;
}

/** Visible width, ignoring ANSI escapes. */
function vw(s: string): number {
  return s.replace(/\x1b\[[0-9;]*m/g, "").length;
}

/**
 * Truncate to `max` visible characters, keeping ANSI escapes intact.
 *
 * The last line of defence before pi's fatal width check. Slicing by string
 * length instead would cut through an escape sequence and spray raw control
 * codes into the transcript, or miscount and overflow anyway.
 */
function clip(s: string, max: number): string {
  if (max <= 0) return "";
  if (vw(s) <= max) return s;
  let out = "";
  let seen = 0;
  const re = /\x1b\[[0-9;]*m/g;
  let last = 0;
  for (let m = re.exec(s); m; m = re.exec(s)) {
    for (const ch of s.slice(last, m.index)) {
      if (seen >= max) return `${out}${RST}`;
      out += ch;
      seen++;
    }
    out += m[0]; // escapes cost no width, so they always survive
    last = m.index + m[0].length;
  }
  for (const ch of s.slice(last)) {
    if (seen >= max) break;
    out += ch;
    seen++;
  }
  return `${out}${RST}`;
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

function row(left: string, right: string, width: number, selected = false): string {
  const inner = Math.max(0, width - 2);
  const budget = inner - vw(right) - 1;
  let l = left;
  if (vw(l) > budget) {
    // Trim by visible width; these strings only carry colour at the edges.
    while (vw(l) > Math.max(0, budget - 1) && l.length) l = l.slice(0, -1);
    l += "…";
  }
  const gap = " ".repeat(Math.max(1, inner - vw(l) - vw(right)));
  const body = `${l}${gap}${right}`;
  // Highlight the whole row, not just the marker, so the selection is obvious
  // at a glance in a list that is repainting every second.
  //
  // Wrapping the body in SEL…RST is not enough: the body already contains its
  // own resets, from the state icon and the dimmed timer, and the first one
  // ends the reverse video two characters in. Measured: only "›●" was ever
  // highlighted. So re-assert SEL after every embedded reset.
  if (selected) {
    const relit = body.replace(/\x1b\[0m/g, `${RST}${SEL}`);
    return `${ACCENT}│${RST}${SEL}${relit}${RST}${ACCENT}│${RST}`;
  }
  return `${ACCENT}│${RST}${body}${ACCENT}│${RST}`;
}

/**
 * Footer carrying the key hints, shown only once the panel has the keyboard.
 *
 * Hidden until then: with no selection the keys do nothing, and advertising
 * them would be a lie. The one hint that is always worth showing is how to get
 * in, which the caller renders as the collapsed form.
 */
function hintBar(width: number, active: boolean): string {
  if (width <= 2) return bottom(width);
  const hint = active ? " ↑↓ select · enter open · ^X stop · esc " : " ↓ to select ";
  const inner = width - 2;
  // Needs room for the hint AND a corner-adjacent dash on each side. With a
  // bare `>` the exact-fit case computed lead=1 and clamped tail from -1 to 0,
  // rendering 42 columns into a 41-column budget - a crash once the width came
  // from the real terminal rather than a hardcoded 78.
  if (hint.length + 2 > inner) return bottom(width);
  const lead = Math.max(1, Math.floor((inner - hint.length) / 2));
  const tail = inner - lead - hint.length;
  return `${ACCENT}╰${"─".repeat(lead)}${RST}${DIM}${hint}${RST}${ACCENT}${"─".repeat(Math.max(0, tail))}╯${RST}`;
}

/** Render the widget, or undefined when nothing is running. */
export function renderWidget(
  agents: Subagent[],
  width = terminalWidth(),
  selected?: string,
): string[] | undefined {
  const live = agents.filter((a) => a.state !== "finished" && a.state !== "failed");
  if (live.length === 0) return undefined;

  // No lower clamp: any floor above the real terminal width is a crash, and
  // pi treats an over-wide widget as fatal rather than clipping it.
  const w = Math.min(width, 120);
  const lines = [top("Subagents", `${live.length} running`, w)];

  for (const a of live) {
    const isSel = a.name === selected;
    // The marker column keeps rows aligned whether or not anything is
    // selected, so the list does not jitter sideways as you move through it.
    const mark = isSel ? "›" : " ";
    const left = `${mark}${icon(a.state)} ${DIM}${elapsed(a.startedAt)}${RST}  ${a.name} ${DIM}(${a.agent})${RST}`;
    const right = `${a.state === "blocked" ? YELLOW : DIM}${label(a.state)}${RST} `;
    lines.push(row(left, right, w, isSel));
  }

  lines.push(hintBar(w, Boolean(selected && live.some((a) => a.name === selected))));
  // Belt and braces: every line is clipped to the width we were given, so no
  // rounding slip in the box drawing above can reach pi's fatal check.
  return lines.map((l) => clip(l, w));
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
    /** Replaces the streaming loader text. No argument restores the default. */
    setWorkingMessage?(message?: string): void;
  };
}

/**
 * Loader text for the streaming indicator while subagents run.
 *
 * The default reads "Working…", which during a blocking subagent call is
 * indistinguishable from the main agent thinking. Naming what is being waited
 * on is the difference between a visible wait and an apparent hang.
 */
export function workingMessage(agents: Subagent[]): string | undefined {
  const live = agents.filter((a) => a.state !== "finished" && a.state !== "failed");
  if (live.length === 0) return undefined;

  const blocked = live.filter((a) => a.state === "blocked");
  if (blocked.length) {
    // Needs a human. Say so instead of implying progress.
    const names = blocked.map((a) => a.name).join(", ");
    return `Subagent ${names} is blocked and needs input`;
  }

  if (live.length === 1) {
    const a = live[0];
    return `Waiting on subagent ${a.name} (${a.agent})`;
  }

  const names = live.map((a) => a.name).join(", ");
  const label = `Waiting on ${live.length} subagents: ${names}`;
  return label.length <= 90 ? label : `Waiting on ${live.length} subagents`;
}

/**
 * Keeps the widget in sync with the registry.
 *
 * The controller PULLS the current agents from a supplier rather than being
 * pushed an array. An earlier version passed the array into `setInterval`,
 * which captured whatever the list looked like when the timer started: with
 * three concurrent spawns the first one to land began the timer holding a
 * one-element snapshot, and every tick afterwards repainted that stale view.
 * Observed live as "1 running" while three subagents were working.
 *
 * A 1s repaint keeps the elapsed timers moving, since herdr's status events
 * only fire on transitions. The interval runs only while something is live.
 */
export class WidgetController {
  private timer?: ReturnType<typeof setInterval>;
  private host?: WidgetHost;
  private supplier: () => Subagent[] = () => [];
  /** Supplies the selected subagent name, owned by the panel. */
  private selection: () => string | undefined = () => undefined;

  attach(host: WidgetHost, supplier?: () => Subagent[], selection?: () => string | undefined): void {
    this.host = host;
    if (supplier) this.supplier = supplier;
    if (selection) this.selection = selection;
  }

  /**
   * Selectable rows, in the order they are drawn.
   *
   * The panel navigates by this list, so it has to be derived from the same
   * filter the renderer uses - otherwise Enter on the third visible row would
   * open whatever the third *tracked* agent happened to be, including one that
   * already finished and left the display.
   */
  rows(): string[] {
    return this.supplier()
      .filter((a) => a.state !== "finished" && a.state !== "failed")
      .map((a) => a.name);
  }

  /** Repaint from live state. */
  update(): void {
    const host = this.host;
    if (!host?.hasUI) return;

    const agents = this.supplier();
    const lines = renderWidget(agents, 78, this.selection());
    try {
      host.ui.setWidget(WIDGET_KEY, lines, { placement: "aboveEditor" });
      // Name what is being waited on; undefined restores pi's default text.
      host.ui.setWorkingMessage?.(workingMessage(agents));
    } catch {
      // A widget failure must never break a spawn.
    }

    if (lines && !this.timer) {
      this.timer = setInterval(() => this.update(), 1000);
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
      // Hand the loader text back, or a stale "Waiting on subagent …" would
      // outlive the subagents and sit there through unrelated turns.
      this.host?.ui.setWorkingMessage?.();
    } catch {
      /* shutting down anyway */
    }
    this.host = undefined;
  }
}
