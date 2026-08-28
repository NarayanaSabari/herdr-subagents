/**
 * Keyboard navigation for the subagent widget.
 *
 * Modelled on Claude Code's agent panel: no chord to learn, no mode to enter.
 * Press Down on an empty editor and the selection lands on the first subagent;
 * Enter jumps to its pane, `x` stops it, Esc gives the keyboard back.
 *
 *     ╭─ Subagents ──────────────────────── 2 running ─╮
 *     │ ● 00:23  scout-ops (scout)          working    │
 *     │›◐ 00:45  explore-api (explore)      starting…  │   <- selected
 *     ╰──── ↑↓ select · enter open · x stop · esc ─────╯
 *
 * Why raw input rather than a widget component: pi widgets render but never
 * receive keys - verified by registering one with a `handleInput` and sending
 * arrows at it, which arrived nowhere. The editor keeps focus at all times.
 * `ctx.ui.custom()` does take focus, but it *replaces the editor* until it is
 * dismissed, so it cannot coexist with a prompt you are still typing into.
 * `ctx.ui.onTerminalInput` is the only hook that sees keys while the editor
 * stays live, and its `{ consume: true }` return keeps a handled key from
 * reaching the editor underneath.
 *
 * Verified against a real pi process that keys arrive *during* streaming, so
 * the panel is usable at exactly the moment it matters: while a blocking
 * `subagent()` call has the main agent parked and the subagents are working.
 *
 * ## Sharing Down with history
 *
 * Down on an empty editor is normally pi's history-next. The panel claims it
 * only while subagents are live and only while the editor is empty, which is
 * the same trade Claude Code makes for the same reason: a panel you must press
 * a chord to reach is a panel you forget exists. Every other moment - text in
 * the editor, no subagents running, no selection - the key passes straight
 * through untouched.
 */

const ESC = "\x1b";

/** Terminal keys, as they actually arrive. */
export type PanelKey = "up" | "down" | "enter" | "escape" | "stop" | "typing" | "other";

/**
 * Kitty CSI-u escape: `\x1b[<codepoint>;<modifier>...u`.
 *
 * pi negotiates the kitty keyboard protocol when the terminal supports it, and
 * this machine's does, so most keys arrive in this form rather than as the
 * classic C0 bytes. The modifier is a bitfield offset by 1, so ctrl alone is
 * 5 (1 + 4).
 */
const CSI_U = /^\x1b\[(\d+)(?:;(\d+))?[;:\d]*u$/;

/** Ctrl bit in a kitty modifier field. */
function hasCtrl(mod: string | undefined): boolean {
  return mod ? ((Number(mod) - 1) & 4) !== 0 : false;
}

/**
 * Classify a raw input chunk.
 *
 * Both the legacy encodings (`\x1b[B`) and the kitty keyboard protocol
 * (`\x1b[1;1:1B` for Down, `\x1b[27u` for Escape, `\x1b[120;5:1u` for Ctrl+X)
 * are matched, because pi negotiates the kitty protocol when the terminal
 * supports it and this machine's does. Reading the terminfo-era codes alone
 * looked correct in tests and did nothing whatsoever in the real terminal -
 * which is exactly how the first Ctrl+X binding shipped broken.
 */
export function classifyKey(data: string): PanelKey {
  if (data === "\r" || data === "\n") return "enter";
  if (data === ESC) return "escape";

  const csi = CSI_U.exec(data);
  if (csi) {
    const code = Number(csi[1]);
    const ctrl = hasCtrl(csi[2]);
    if (code === 27) return "escape";
    if (code === 13) return "enter";
    // Ctrl+X stops, not a bare "x". A plain letter cannot be a destructive
    // shortcut here: pi's editor never loses focus, so the panel and the
    // prompt share a keyboard. Someone who pressed Down to check on a run and
    // then typed "xcode build is broken" would have killed a subagent with the
    // first keystroke, silently. Claude Code's agent view uses Ctrl+X too.
    if (code === 120 && ctrl) return "stop";
    // Any other printable codepoint with no ctrl is the user writing a prompt.
    if (!ctrl && code >= 32 && code !== 127) return "typing";
    return "other";
  }

  // Classic C0 control byte, for terminals without the kitty protocol.
  if (data === "\x18") return "stop";

  if (data.startsWith(`${ESC}[`) || data.startsWith(`${ESC}O`)) {
    const final = data[data.length - 1];
    if (final === "A") return "up";
    if (final === "B") return "down";
  }
  // A printable character means the user has started writing a prompt.
  if (data.length === 1 && data >= " " && data !== "\x7f") return "typing";
  return "other";
}

/** What the host should do after a key. */
export type PanelAction =
  | { kind: "none" }
  | { kind: "redraw" }
  | { kind: "open"; name: string }
  | { kind: "stop"; name: string };

export interface PanelResult {
  /** Whether the key was swallowed and must not reach the editor. */
  consume: boolean;
  action: PanelAction;
}

/**
 * How long a selection survives without a keypress.
 *
 * The panel can only wedge a dialog it cannot see if it is still holding the
 * keyboard when that dialog opens. Selections exist to be acted on within a
 * few seconds, so releasing an idle one costs the user nothing and closes most
 * of the window: a selection made a minute ago is not one they are still
 * steering.
 */
const IDLE_RELEASE_MS = 15_000;

const PASS: PanelResult = { consume: false, action: { kind: "none" } };
const EATEN: PanelResult = { consume: true, action: { kind: "redraw" } };

/**
 * Selection state for the panel.
 *
 * Selection is tracked by *name*, not index. Rows appear and disappear on
 * their own as subagents finish, so an index would silently slide onto a
 * different agent underneath the user's cursor - and Enter would then focus
 * the wrong pane. A name either still exists or the selection clears.
 */
export class PanelState {
  private selected?: string;
  private touchedAt = 0;

  /** Injectable clock, so the idle release is testable without waiting. */
  now: () => number = () => Date.now();

  /** Currently selected subagent, if the selection is still valid. */
  selection(rows: string[]): string | undefined {
    // An abandoned selection releases the keyboard on its own.
    if (this.selected && this.now() - this.touchedAt > IDLE_RELEASE_MS) {
      this.selected = undefined;
      return undefined;
    }
    if (this.selected && rows.includes(this.selected)) return this.selected;
    // The selected agent finished and left the list.
    if (this.selected) this.selected = undefined;
    return undefined;
  }

  /** True when the panel owns the keyboard. */
  active(rows: string[]): boolean {
    return this.selection(rows) !== undefined;
  }

  clear(): void {
    this.selected = undefined;
  }

  select(name: string | undefined): void {
    this.selected = name;
    this.touchedAt = this.now();
  }

  /**
   * Handle a key.
   *
   * `rows` is the live list of selectable subagent names, `editorEmpty` gates
   * every interaction: with text in the editor the panel is invisible to the
   * keyboard, so arrows edit the prompt exactly as they always did.
   *
   * `modal` suspends the panel entirely. pi exposes no "is a dialog open"
   * flag, and a dialog leaves the editor empty, so without this the panel
   * would happily eat the arrow keys of a tool-approval prompt. Verified on
   * 2026-08-28 that a consumed Down never reaches an open `ctx.ui.select()`:
   * the highlight stayed on the first option, so a user with a selection
   * active could not answer the prompt. That is a wedged session, the worst
   * outcome available to this feature, so the panel yields unconditionally.
   */
  handle(data: string, rows: string[], editorEmpty: boolean, modal = false): PanelResult {
    if (modal) {
      // Do not clear: the dialog is transient and the user should find their
      // selection where they left it.
      return PASS;
    }
    if (!rows.length) {
      this.clear();
      return PASS;
    }
    // Text in the editor means the user is writing, not browsing. Drop the
    // selection rather than merely ignoring keys: a selection that survives
    // typing comes back to life the moment the editor is empty again, so
    // "press Down, type hello, delete it, press Enter" would jump to a
    // subagent pane instead of submitting the prompt.
    if (!editorEmpty) {
      this.clear();
      return PASS;
    }

    const key = classifyKey(data);
    const current = this.selection(rows);
    const at = current ? rows.indexOf(current) : -1;

    switch (key) {
      case "down": {
        // First Down enters the panel; subsequent ones walk down and stop at
        // the end rather than wrapping, so holding the key cannot cycle you
        // past the agent you were aiming for.
        this.select(at < 0 ? rows[0] : rows[Math.min(at + 1, rows.length - 1)]);
        return EATEN;
      }
      case "up": {
        // Up outside the panel belongs to history: leave it alone.
        if (at < 0) return PASS;
        // Up off the top leaves the panel rather than trapping the keyboard.
        if (at === 0) {
          this.clear();
          return EATEN;
        }
        this.select(rows[at - 1]);
        return EATEN;
      }
      case "escape": {
        if (at < 0) return PASS;
        this.clear();
        // Deliberately NOT consumed. Escape is the universal way out of a
        // dialog and of a streaming turn, and the panel cannot see either. If
        // a prompt is open that we failed to detect, this key still reaches
        // it; the cost is that Escape also cancels the turn, which is what an
        // Escape press means everywhere else in pi anyway.
        return { consume: false, action: { kind: "redraw" } };
      }
      case "enter": {
        if (at < 0) return PASS;
        // Only an actively-steered selection may swallow Enter. Without this,
        // a dialog opening while a selection sits idle would find its Enter
        // eaten by the panel, and pi gives no way to detect that dialog. The
        // arrow keys that got you here are the consent.
        if (this.now() - this.touchedAt > IDLE_RELEASE_MS) {
          this.clear();
          return PASS;
        }
        const name = rows[at];
        // Focus moves to the child's pane, so the selection has served its
        // purpose; leaving it set would put the keyboard back in the panel
        // when the user returns.
        this.clear();
        return { consume: true, action: { kind: "open", name } };
      }
      case "stop": {
        if (at < 0) return PASS;
        const name = rows[at];
        return { consume: true, action: { kind: "stop", name } };
      }
      case "typing": {
        // Typing means the panel is no longer what the user is looking at.
        // Release the keyboard and let the character through, so the editor
        // never drops a keystroke - the selection was only ever a viewing aid.
        if (at >= 0) {
          this.clear();
          return { consume: false, action: { kind: "redraw" } };
        }
        return PASS;
      }
      default:
        return PASS;
    }
  }
}
