/**
 * Tests for the behaviour that changed in 0.2.0: pane layout, the
 * exit-versus-completion race, and the status widget.
 */

import { strict as assert } from "node:assert";
import { test } from "node:test";

import { SubagentRegistry, type Subagent } from "../src/registry.ts";
import { renderWidget } from "../src/widget.ts";

function fakeSub(over: Partial<Subagent> = {}): Subagent {
  let settle!: (s: Subagent) => void;
  const done = new Promise<Subagent>((r) => {
    settle = r;
  });
  return {
    name: "scout",
    agent: "scout",
    task: "t",
    paneId: "w1:p2",
    parentPaneId: "w1:p1",
    sessionDir: "/tmp/x",
    sessionId: "x",
    state: "starting",
    startedAt: Date.now(),
    done,
    settle,
    ...over,
  };
}

// ── the exit-vs-completion race ────────────────────────────────────────────
//
// Panes now auto-close on success, so `pane.exited` arrives for healthy
// subagents too. Treating an exit as failure would discard real results
// whenever it beat the final status event.

test("pane exit WITH a result counts as finished, not failed", () => {
  const reg = new SubagentRegistry();
  reg.hasResult = () => true; // the child wrote a final message
  const s = fakeSub();
  reg.add(s);
  reg.transition("scout", "working");

  reg.handleEvent("pane.exited", { pane_id: "w1:p2" });

  assert.equal(reg.get("scout")?.state, "finished");
  reg.dispose();
});

test("pane exit WITHOUT a result is a failure", () => {
  const reg = new SubagentRegistry();
  reg.hasResult = () => false; // nothing was ever written
  const s = fakeSub();
  reg.add(s);
  reg.transition("scout", "working");

  reg.handleEvent("pane.exited", { pane_id: "w1:p2" });

  assert.equal(reg.get("scout")?.state, "failed");
  assert.match(reg.get("scout")?.error ?? "", /exited before/);
  reg.dispose();
});

test("a settled subagent resolves its done promise", async () => {
  const reg = new SubagentRegistry();
  reg.hasResult = () => true;
  const s = fakeSub();
  reg.add(s);
  reg.transition("scout", "working");
  reg.transition("scout", "finished");
  const settled = await s.done;
  assert.equal(settled.state, "finished");
  assert.ok(settled.finishedAt);
  reg.dispose();
});

test("idle before any work does not count as completion", () => {
  // herdr reports a freshly started agent as idle while it waits for input;
  // finishing on that would return an empty result instantly.
  const reg = new SubagentRegistry();
  reg.hasResult = () => true;
  reg.add(fakeSub());
  reg.handleEvent("pane.agent_status_changed", { pane_id: "w1:p2", agent_status: "idle" });
  assert.equal(reg.get("scout")?.state, "starting");
  reg.dispose();
});

test("idle after work counts as completion", () => {
  const reg = new SubagentRegistry();
  reg.hasResult = () => true;
  reg.add(fakeSub());
  reg.handleEvent("pane.agent_status_changed", { pane_id: "w1:p2", agent_status: "working" });
  reg.handleEvent("pane.agent_status_changed", { pane_id: "w1:p2", agent_status: "idle" });
  assert.equal(reg.get("scout")?.state, "finished");
  reg.dispose();
});

test("blocked is surfaced as its own state", () => {
  const reg = new SubagentRegistry();
  reg.add(fakeSub());
  reg.handleEvent("pane.agent_status_changed", { pane_id: "w1:p2", agent_status: "blocked" });
  assert.equal(reg.get("scout")?.state, "blocked");
  reg.dispose();
});

test("a terminal state is never overwritten", () => {
  const reg = new SubagentRegistry();
  reg.hasResult = () => true;
  reg.add(fakeSub());
  reg.transition("scout", "working");
  reg.transition("scout", "finished");
  reg.handleEvent("pane.exited", { pane_id: "w1:p2" });
  assert.equal(reg.get("scout")?.state, "finished");
  reg.dispose();
});

test("names are de-duplicated across concurrent spawns", () => {
  const reg = new SubagentRegistry();
  assert.equal(reg.uniqueName("scout"), "scout");
  reg.add(fakeSub({ name: "scout" }));
  assert.equal(reg.uniqueName("scout"), "scout-2");
  reg.add(fakeSub({ name: "scout-2", paneId: "w1:p3" }));
  assert.equal(reg.uniqueName("scout"), "scout-3");
  reg.dispose();
});

// ── widget ─────────────────────────────────────────────────────────────────

test("widget is hidden when nothing is running", () => {
  assert.equal(renderWidget([]), undefined);
  const doneAgent = fakeSub({ state: "finished" });
  assert.equal(renderWidget([doneAgent]), undefined);
});

test("widget renders one row per live subagent", () => {
  const lines = renderWidget([
    fakeSub({ name: "scout-ops", state: "working" }),
    fakeSub({ name: "explore-api", agent: "explore", state: "starting" }),
  ]);
  assert.ok(lines);
  assert.equal(lines.length, 4); // top + 2 rows + bottom
  assert.match(lines[0], /Subagents/);
  assert.match(lines[0], /2 running/);
  assert.match(lines[1], /scout-ops/);
  assert.match(lines[2], /explore-api/);
});

test("widget flags a blocked subagent prominently", () => {
  const lines = renderWidget([fakeSub({ state: "blocked" })]);
  assert.ok(lines);
  assert.match(lines[1], /BLOCKED/);
});

test("widget rows stay within the requested width", () => {
  const strip = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, "");
  const lines = renderWidget(
    [fakeSub({ name: "a-very-long-subagent-name-that-will-not-fit-here", state: "working" })],
    50,
  );
  assert.ok(lines);
  for (const l of lines) assert.ok(strip(l).length <= 50, `line too wide: ${strip(l).length}`);
});

// ── pane layout ────────────────────────────────────────────────────────────

test("concurrent spawns split main ONCE, then stack downward", async () => {
  // Reproduces a bug measured in a live session: three parallel subagent
  // calls each read an empty column and each split main, leaving main at
  // 12 of 94 columns with all four panes side by side.
  const { createSubagentPane, resetColumns, trackedColumn, setPaneOps } =
    await import("../src/layout.ts");

  const calls: { from?: string; dir: string }[] = [];
  let n = 1;
  const restore = setPaneOps({
    async splitPane(o) {
      calls.push({ from: o.fromPaneId, dir: o.direction });
      await new Promise((r) => setTimeout(r, 5)); // widen the race window
      return `w1:p${++n}`;
    },
    async paneExists() {
      return true;
    },
  });

  resetColumns();
  try {
    const panes = await Promise.all(
      [1, 2, 3].map(() => createSubagentPane({ parentPaneId: "w1:p1", cwd: "/tmp" })),
    );

    const fromMain = calls.filter((c) => c.from === "w1:p1");
    assert.equal(fromMain.length, 1, "main must be split exactly once");
    assert.equal(fromMain[0].dir, "right", "main splits to the right");
    for (const c of calls.filter((c) => c.from !== "w1:p1")) {
      assert.equal(c.dir, "down", "later subagents stack downward");
    }
    assert.equal(trackedColumn("w1:p1").length, 3);
    assert.equal(new Set(panes).size, 3, "each spawn gets its own pane");
  } finally {
    restore();
    resetColumns();
  }
});

test("an emptied column starts fresh, splitting main again", async () => {
  const { createSubagentPane, releaseSubagentPane, resetColumns, setPaneOps } =
    await import("../src/layout.ts");

  const calls: { from?: string; dir: string }[] = [];
  let n = 1;
  const restore = setPaneOps({
    async splitPane(o) {
      calls.push({ from: o.fromPaneId, dir: o.direction });
      return `w1:p${++n}`;
    },
    async paneExists() {
      return true;
    },
  });

  resetColumns();
  try {
    const first = await createSubagentPane({ parentPaneId: "w1:p1", cwd: "/tmp" });
    releaseSubagentPane("w1:p1", first); // it finished and its pane closed
    await createSubagentPane({ parentPaneId: "w1:p1", cwd: "/tmp" });
    assert.equal(
      calls.filter((c) => c.from === "w1:p1").length,
      2,
      "after the column empties, main is split again",
    );
  } finally {
    restore();
    resetColumns();
  }
});

// ── widget freshness ───────────────────────────────────────────────────────

test("widget repaints from LIVE state, not a captured snapshot", async () => {
  // Observed live: three subagents working, widget stuck on "1 running".
  //
  // The old controller took the array as an argument and passed that same
  // array into setInterval, so the timer replayed whatever the list looked
  // like when it started. Reproduced against that version: the widget paints
  // "3 running", then the first tick reverts it to "1 running".
  //
  // The supplier must therefore be consulted on every tick, which is what
  // this asserts - a test that only checked the paint immediately after
  // update() passes against the buggy version too.
  const { WidgetController } = await import("../src/widget.ts");

  const registry: Subagent[] = [];
  const all = () => [...registry]; // a fresh array each call, like registry.all()
  let painted: string[] | undefined;

  const wc = new WidgetController();
  wc.attach(
    { hasUI: true, ui: { setWidget: (_k: string, c: string[] | undefined) => (painted = c) } },
    all,
  );

  registry.push(fakeSub({ name: "a", state: "working" }));
  wc.update(); // starts the repaint timer

  registry.push(fakeSub({ name: "b", paneId: "w1:p3", state: "working" }));
  registry.push(fakeSub({ name: "c", paneId: "w1:p4", state: "working" }));
  wc.update();

  assert.match(painted?.[0] ?? "", /3 running/, "immediate paint shows all three");

  await new Promise((r) => setTimeout(r, 1100));
  assert.match(
    painted?.[0] ?? "",
    /3 running/,
    "after a timer tick the widget must still show three, not a stale one",
  );
  assert.equal(painted?.length, 5, "top + three rows + bottom");

  wc.dispose();
});
