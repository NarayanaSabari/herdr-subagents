/**
 * Panel keyboard navigation.
 *
 * The bar these tests have to clear: an earlier widget regression test in this
 * repo passed against the buggy code, because it asserted on a value it had
 * just computed rather than on state after a tick. So each test here drives
 * the real `handle()` and asserts on what a *user* would see next: whether the
 * key reached the editor, and which agent Enter would open.
 */

import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

import { PanelState, classifyKey } from "../src/panel.ts";
import { renderWidget } from "../src/widget.ts";
import type { Subagent } from "../src/registry.ts";

const ROWS = ["scout", "explore", "retrieval"];
const EMPTY = true;

function sub(name: string, state: Subagent["state"] = "working"): Subagent {
  return {
    name,
    agent: "scout",
    task: "t",
    paneId: `w1:p${name.length}`,
    parentPaneId: "w1:p1",
    sessionDir: "/tmp",
    sessionId: name,
    state,
    startedAt: Date.now() - 5000,
    done: Promise.resolve() as unknown as Promise<Subagent>,
  };
}

describe("key classification", () => {
  it("reads the kitty protocol encodings this terminal actually sends", () => {
    // Captured from a live pi process; matching only "\x1b[B" would have
    // looked correct in tests and done nothing in the real terminal.
    assert.equal(classifyKey("\x1b[1;1:1B"), "down");
    assert.equal(classifyKey("\x1b[1;1:1A"), "up");
    assert.equal(classifyKey("\x1b[27u"), "escape");
  });

  it("still reads the legacy encodings", () => {
    assert.equal(classifyKey("\x1b[B"), "down");
    assert.equal(classifyKey("\x1b[A"), "up");
    assert.equal(classifyKey("\x1bOB"), "down");
    assert.equal(classifyKey("\x1b"), "escape");
    assert.equal(classifyKey("\r"), "enter");
  });

  /**
   * Regression: the stop binding first matched only the C0 byte `\x18`. Every
   * unit test passed and Ctrl+X did nothing at all in the real terminal,
   * because pi negotiates the kitty protocol, which sends CSI-u instead. These
   * are the bytes captured from a live pi process on 2026-08-28.
   */
  it("reads Ctrl+X in the kitty encoding the terminal really sends", () => {
    assert.equal(classifyKey("\x1b[120;5:1u"), "stop");
  });

  it("still reads Ctrl+X as a C0 byte, for terminals without kitty", () => {
    assert.equal(classifyKey("\x18"), "stop");
  });

  it("does not mistake a kitty-encoded plain x for Ctrl+X", () => {
    // Modifier 1 means no modifiers: this is someone typing the letter.
    assert.equal(classifyKey("\x1b[120;1u"), "typing");
    assert.equal(classifyKey("\x1b[120u"), "typing");
  });

  it("treats a bare x as typing, not as a destructive shortcut", () => {
    assert.equal(classifyKey("a"), "typing");
    assert.equal(classifyKey("x"), "typing", "a plain letter must never stop a subagent");
    assert.equal(classifyKey("\x18"), "stop", "Ctrl+X is the stop key");
  });
});

describe("entering and leaving the panel", () => {
  it("first Down selects the first row and swallows the key", () => {
    const p = new PanelState();
    const r = p.handle("\x1b[B", ROWS, EMPTY);
    assert.equal(r.consume, true, "Down must not also reach history");
    assert.equal(p.selection(ROWS), "scout");
  });

  it("Down walks the list and stops at the end rather than wrapping", () => {
    const p = new PanelState();
    // Press count matters: a multiple of the row count lands on the last row
    // under BOTH clamping and wrapping, so it would prove nothing. Five
    // presses on three rows separates them - clamped stays on "retrieval",
    // wrapped comes back around to "explore".
    for (let i = 0; i < 5; i++) p.handle("\x1b[B", ROWS, EMPTY);
    assert.equal(p.selection(ROWS), "retrieval", "holding Down must not cycle past the end");
  });

  it("Up off the top leaves the panel instead of trapping the keyboard", () => {
    const p = new PanelState();
    p.handle("\x1b[B", ROWS, EMPTY);
    const r = p.handle("\x1b[A", ROWS, EMPTY);
    assert.equal(r.consume, true);
    assert.equal(p.selection(ROWS), undefined, "should have exited the panel");
  });

  it("Escape clears the selection", () => {
    const p = new PanelState();
    p.handle("\x1b[B", ROWS, EMPTY);
    p.handle("\x1b[27u", ROWS, EMPTY);
    assert.equal(p.selection(ROWS), undefined);
  });
});

describe("keys the panel must not steal", () => {
  it("passes every key through while the editor has text", () => {
    const p = new PanelState();
    for (const k of ["\x1b[B", "\x1b[A", "\r", "x", "\x1b", "\x18"]) {
      const r = p.handle(k, ROWS, false);
      assert.equal(r.consume, false, `${JSON.stringify(k)} must reach the editor`);
    }
    assert.equal(p.selection(ROWS), undefined);
  });

  it("passes every key through when no subagents are running", () => {
    const p = new PanelState();
    for (const k of ["\x1b[B", "\x1b[A", "\r", "x", "\x18"]) {
      assert.equal(p.handle(k, [], EMPTY).consume, false);
    }
  });

  it("leaves Up alone outside the panel, so history-prev still works", () => {
    const p = new PanelState();
    const r = p.handle("\x1b[A", ROWS, EMPTY);
    assert.equal(r.consume, false, "Up with no selection belongs to history");
  });

  it("leaves Enter alone outside the panel, so prompts still submit", () => {
    const p = new PanelState();
    assert.equal(p.handle("\r", ROWS, EMPTY).consume, false);
  });

  it("types a literal x when the panel does not have the keyboard", () => {
    const p = new PanelState();
    const r = p.handle("x", ROWS, EMPTY);
    assert.equal(r.consume, false, "x outside the panel is just a character");
    assert.equal(r.action.kind, "none");
  });

  /**
   * The sharp edge of sharing a keyboard with the editor: the panel holds the
   * selection, but the user can start typing a prompt at any moment. Every
   * character must survive, and a letter must never act as a command.
   */
  it("releases the keyboard the moment the user starts typing", () => {
    const p = new PanelState();
    p.handle("\x1b[B", ROWS, EMPTY);
    const r = p.handle("x", ROWS, EMPTY);
    assert.equal(r.consume, false, "the x must reach the editor, not vanish");
    assert.notEqual(r.action.kind, "stop", "typing must never stop a subagent");
    assert.equal(p.selection(ROWS), undefined, "selection clears once you type");
  });

  it("does not drop the first character of a typed word", () => {
    const p = new PanelState();
    p.handle("\x1b[B", ROWS, EMPTY);
    for (const ch of "xcode") {
      assert.equal(p.handle(ch, ROWS, ch === "x").consume, false, `dropped ${ch}`);
    }
  });
});

describe("acting on the selection", () => {
  it("Enter reports the selected agent and releases the keyboard", () => {
    const p = new PanelState();
    p.handle("\x1b[B", ROWS, EMPTY);
    p.handle("\x1b[B", ROWS, EMPTY);
    const r = p.handle("\r", ROWS, EMPTY);
    assert.deepEqual(r.action, { kind: "open", name: "explore" });
    assert.equal(
      p.selection(ROWS),
      undefined,
      "focus moved away, so the panel must not still hold the keyboard",
    );
  });

  it("Ctrl+X reports a stop for the selected agent and keeps it selected", () => {
    const p = new PanelState();
    p.handle("\x1b[B", ROWS, EMPTY);
    const r = p.handle("\x18", ROWS, EMPTY);
    assert.deepEqual(r.action, { kind: "stop", name: "scout" });
    assert.equal(r.consume, true);
  });
});

describe("the list changing underneath the selection", () => {
  it("drops a selection whose agent finished", () => {
    const p = new PanelState();
    p.handle("\x1b[B", ROWS, EMPTY);
    assert.equal(p.selection(["explore", "retrieval"]), undefined);
  });

  it("keeps pointing at the same agent when rows above it disappear", () => {
    // Selection is by name, not index. With an index, "scout" finishing would
    // slide the cursor onto a different agent and Enter would open the wrong
    // pane.
    const p = new PanelState();
    p.handle("\x1b[B", ROWS, EMPTY);
    p.handle("\x1b[B", ROWS, EMPTY);
    assert.equal(p.selection(ROWS), "explore");
    assert.equal(p.selection(["explore", "retrieval"]), "explore");
  });

  it("re-enters at the top after the selected agent vanishes", () => {
    const p = new PanelState();
    p.handle("\x1b[B", ROWS, EMPTY);
    const remaining = ["explore", "retrieval"];
    const r = p.handle("\x1b[B", remaining, EMPTY);
    assert.equal(r.consume, true);
    assert.equal(p.selection(remaining), "explore");
  });
});

describe("rendering the selection", () => {
  it("marks the selected row and shows the key hints", () => {
    const lines = renderWidget([sub("scout"), sub("explore")], 78, "explore");
    assert.ok(lines);
    const body = lines.join("\n");
    assert.match(body, /›/, "selected row needs a marker");
    assert.match(body, /enter open/, "hints appear once the panel is active");
  });

  it("shows only the way in when nothing is selected", () => {
    const lines = renderWidget([sub("scout")], 78);
    assert.ok(lines);
    const body = lines.join("\n");
    assert.doesNotMatch(body, /enter open/, "do not advertise keys that do nothing");
    assert.match(body, /to select/);
  });

  it("never renders a line wider than the terminal, at any width", () => {
    // pi does not clip an over-wide widget: tui-main-screen throws "Rendered
    // line N exceeds terminal width" and takes the session down. The widget
    // used to draw at a hardcoded 78 regardless of the real terminal, so any
    // pane under 78 columns was a latent crash - and subagents make narrow
    // panes normal, because every spawn splits the window.
    const agents = [sub("a-very-long-subagent-name-here"), sub("b", "blocked")];
    const original = process.stdout.columns;
    try {
      for (const term of [200, 120, 100, 80, 60, 50, 40, 30, 20, 12, 6, 3]) {
        Object.defineProperty(process.stdout, "columns", { value: term, configurable: true });
        for (const sel of [undefined, "b"]) {
          const lines = renderWidget(agents, undefined, sel)!;
          for (const l of lines) {
            const visible = l.replace(/\x1b\[[0-9;]*m/g, "").length;
            assert.ok(visible <= term, `at ${term} cols a line was ${visible} wide: ${JSON.stringify(l)}`);
          }
        }
      }
    } finally {
      Object.defineProperty(process.stdout, "columns", { value: original, configurable: true });
    }
  });

  it("never renders a line wider than an explicitly requested width", () => {
    // A previous renderer crashed pi outright with "Rendered line 32 exceeds
    // terminal width". Selection adds a marker and a highlight, so re-check.
    for (const width of [30, 40, 78, 120]) {
      const lines = renderWidget([sub("a-very-long-subagent-name-here"), sub("b")], width, "b");
      assert.ok(lines);
      for (const l of lines) {
        const visible = l.replace(/\x1b\[[0-9;]*m/g, "").length;
        assert.ok(visible <= width, `line of ${visible} exceeds ${width}: ${JSON.stringify(l)}`);
      }
    }
  });

  it("keeps rows aligned whether or not anything is selected", () => {
    const agents = [sub("scout"), sub("explore")];
    const plain = renderWidget(agents, 78)!;
    const picked = renderWidget(agents, 78, "scout")!;
    const w = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, "").length;
    assert.equal(w(plain[1]), w(picked[1]), "the list must not jitter sideways");
  });
});

describe("stopping a subagent", () => {
  /**
   * Regression: the first implementation sent `ctrl+c`, which pi ignores.
   * Observed live on 2026-08-28 - the child reported `working` for the full
   * sleep after "Stopping subagent longa…" appeared, so the panel claimed to
   * have stopped something it had not touched. `esc` is pi's interrupt;
   * Ctrl+C is its quit-on-empty-prompt chord.
   */
  it("interrupts with the key pi actually honours", () => {
    const src = readFileSync(new URL("../src/index.ts", import.meta.url), "utf8");
    const stop = src.slice(src.indexOf("async function stopSubagent"));
    const body = stop.slice(0, stop.indexOf("\n  }"));
    assert.match(body, /sendKeys\(name, "esc"\)/, "must send esc");
    assert.doesNotMatch(body, /ctrl\+c/, "ctrl+c does not interrupt a working pi child");
  });

  /**
   * Regression: a stopped subagent came back as "finished but produced no
   * readable result", which reads like a malfunction. The main agent's own
   * summary then had to guess whether to retry.
   */
  it("reports a user stop as a stop, not as a missing result", () => {
    const src = readFileSync(new URL("../src/index.ts", import.meta.url), "utf8");
    assert.match(src, /was stopped by the user/);
    assert.match(src, /Do not restart it unless asked/);
  });
});

/**
 * Findings from an independent review pass, each reproduced before it was
 * fixed. These are the cases where the panel could take a key that belonged to
 * someone else - the failure mode that turns a convenience into a trap.
 */
describe("not wedging the session", () => {
  it("drops the selection as soon as the editor has text", () => {
    // Reported: selection survived typing, so it came back to life once the
    // editor was empty again. "Down, type hello, delete it, Enter" then jumped
    // to a subagent pane instead of submitting the prompt.
    const p = new PanelState();
    p.handle("\x1b[B", ROWS, EMPTY);
    p.handle("h", ROWS, false);
    assert.equal(p.selection(ROWS), undefined);
    assert.equal(p.handle("\r", ROWS, EMPTY).consume, false, "Enter must submit the prompt");
  });

  it("never consumes Escape, so a dialog can always be dismissed", () => {
    const p = new PanelState();
    p.handle("\x1b[B", ROWS, EMPTY);
    const r = p.handle("\x1b[27u", ROWS, EMPTY);
    assert.equal(r.consume, false, "Escape must reach whatever else is listening");
    assert.equal(p.selection(ROWS), undefined, "and still exit the panel");
  });

  it("passes everything through while a modal is open", () => {
    // Verified live: a consumed Down never reaches an open ctx.ui.select(),
    // leaving the user unable to answer an approval prompt.
    const p = new PanelState();
    p.handle("\x1b[B", ROWS, EMPTY);
    for (const k of ["\x1b[B", "\x1b[A", "\r", "\x18"]) {
      assert.equal(p.handle(k, ROWS, EMPTY, true).consume, false, `${JSON.stringify(k)} leaked`);
    }
  });

  it("releases an abandoned selection instead of holding the keyboard", () => {
    const p = new PanelState();
    let t = 1_000;
    p.now = () => t;
    p.handle("\x1b[B", ROWS, EMPTY);
    assert.equal(p.selection(ROWS), "scout");
    t += 20_000;
    assert.equal(p.selection(ROWS), undefined, "a stale selection must not keep eating keys");
  });

  it("does not act on Enter for a selection the user stopped steering", () => {
    const p = new PanelState();
    let t = 1_000;
    p.now = () => t;
    p.handle("\x1b[B", ROWS, EMPTY);
    t += 20_000;
    const r = p.handle("\r", ROWS, EMPTY);
    assert.equal(r.consume, false, "a stale Enter belongs to the editor or a dialog");
    assert.notEqual(r.action.kind, "open");
  });

  it("still acts on Enter while the user is actively navigating", () => {
    const p = new PanelState();
    let t = 1_000;
    p.now = () => t;
    p.handle("\x1b[B", ROWS, EMPTY);
    t += 500;
    const r = p.handle("\r", ROWS, EMPTY);
    assert.deepEqual(r.action, { kind: "open", name: "scout" });
  });
});

describe("the selection highlight", () => {
  it("highlights the whole row, not just the marker", () => {
    // Reported: the row body carries its own resets from the icon and the
    // dimmed timer, and the first one ended the reverse video two characters
    // in, so only "›●" was ever highlighted.
    const line = renderWidget([sub("scout")], 78, "scout")![1];

    // Walk the line tracking whether reverse video is currently ON, and
    // collect only the characters actually rendered highlighted. Stripping
    // the escapes first - as an earlier version of this test did - throws away
    // the very information that says where the highlight stops, so it passed
    // against the bug it was written to catch.
    let on = false;
    let highlighted = "";
    const re = /\x1b\[([0-9;]*)m/g;
    let last = 0;
    for (let m = re.exec(line); m; m = re.exec(line)) {
      if (on) highlighted += line.slice(last, m.index);
      if (m[1] === "7") on = true;
      else if (m[1] === "0" || m[1] === "") on = false;
      last = m.index + m[0].length;
    }
    if (on) highlighted += line.slice(last);

    assert.ok(
      highlighted.includes("scout"),
      `highlight stopped early, covering only ${JSON.stringify(highlighted)}`,
    );
    assert.ok(highlighted.includes("working"), "highlight must reach the status label");
  });
});
