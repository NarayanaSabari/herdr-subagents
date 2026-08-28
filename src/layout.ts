/**
 * Pane layout for subagents: main on the left, subagents stacked on the right.
 *
 * ## The bug this exists to fix
 *
 * Splitting the caller's pane on every spawn halves the main pane each time.
 * Measured in a real session with three subagents, in a 181-column window:
 *
 *     181 -> 90 -> 45 -> 26
 *     p1 MAIN(26) | p6 scout(20) | p5 explore(45) | p4 explore(90)
 *
 * The main pane ended at 14% of the window and the subagents were interleaved
 * beside it in spawn order rather than grouped.
 *
 * ## The shape we want
 *
 *     +--------------+--------------+
 *     |              |  subagent 1  |
 *     |     MAIN     +--------------+
 *     |     50%      |  subagent 2  |
 *     |              +--------------+
 *     |              |  subagent 3  |
 *     +--------------+--------------+
 *
 * So: the first spawn splits the main pane once, to the right, at 1:1. Every
 * later spawn splits the *last subagent pane downward*, never touching main
 * again. Main keeps its half no matter how many subagents run.
 *
 * The column is tracked per parent pane. When every subagent finishes and its
 * pane closes, the column is forgotten and the next spawn starts a fresh one,
 * which is what makes main reclaim the full width.
 */

import { paneExists as realPaneExists, splitPane as realSplitPane } from "./herdr.ts";

/**
 * Pane operations, injectable so the concurrency behaviour can be tested
 * without a live herdr server. ES module bindings are read-only, so a seam
 * here is the only way to exercise the race this module exists to prevent.
 */
export interface PaneOps {
  splitPane: typeof realSplitPane;
  paneExists: typeof realPaneExists;
}

let ops: PaneOps = { splitPane: realSplitPane, paneExists: realPaneExists };

/** Test seam: swap the pane operations. Returns a restore function. */
export function setPaneOps(next: Partial<PaneOps>): () => void {
  const prev = ops;
  ops = { ...ops, ...next };
  return () => {
    ops = prev;
  };
}

/** Panes forming the subagent column, oldest first, for one parent pane. */
const columns = new Map<string, string[]>();

/**
 * Serialises pane creation per parent pane.
 *
 * Parallel spawning is the normal case - the model issues several `subagent`
 * calls in one turn and they run concurrently - which makes "read the column,
 * then split" a check-then-act race. Measured with three concurrent spawns:
 * all three read an empty column, all three took the first-spawn branch, and
 * main was split three times down to 12 of 94 columns.
 *
 * Chaining each parent's splits through one promise means the second spawn
 * observes the pane the first created, so only the first splits main and the
 * rest stack beneath it.
 */
const locks = new Map<string, Promise<unknown>>();

function withColumnLock<T>(parentPaneId: string, fn: () => Promise<T>): Promise<T> {
  const prev = locks.get(parentPaneId) ?? Promise.resolve();
  const next = prev.then(fn, fn);
  // Keep the chain alive but never let a rejection poison later spawns.
  locks.set(
    parentPaneId,
    next.catch(() => undefined),
  );
  return next;
}

/**
 * Choose where the next subagent pane goes and create it.
 *
 * - No live column yet: split `parentPaneId` to the right at 1:1.
 * - Column exists: split its last live pane downward, so subagents stack.
 *
 * Panes that have since closed are pruned first, so a column that emptied out
 * behaves exactly like a fresh one.
 */
export async function createSubagentPane(opts: {
  parentPaneId: string;
  cwd: string;
  env?: Record<string, string>;
}): Promise<string> {
  return withColumnLock(opts.parentPaneId, async () => {
    const existing = await liveColumn(opts.parentPaneId);

    const paneId = existing.length
      ? await ops.splitPane({
          fromPaneId: existing[existing.length - 1],
          direction: "down",
          cwd: opts.cwd,
          env: opts.env,
        })
      : await ops.splitPane({
          fromPaneId: opts.parentPaneId,
          direction: "right",
          ratio: 0.5,
          cwd: opts.cwd,
          env: opts.env,
        });

    columns.set(opts.parentPaneId, [...existing, paneId]);
    return paneId;
  });
}

/** Forget a pane once it closes, so the column shrinks as work completes. */
export function releaseSubagentPane(parentPaneId: string, paneId: string): void {
  const col = columns.get(parentPaneId);
  if (!col) return;
  const next = col.filter((p) => p !== paneId);
  if (next.length) columns.set(parentPaneId, next);
  else columns.delete(parentPaneId);
}

/**
 * The column's panes that still exist.
 *
 * A pane can vanish without us being told - the user closes it, or a crash
 * takes it - so this is verified against herdr rather than trusted from local
 * state. Splitting from a dead pane would fail the whole spawn.
 */
async function liveColumn(parentPaneId: string): Promise<string[]> {
  const col = columns.get(parentPaneId);
  if (!col?.length) return [];

  const alive: string[] = [];
  for (const p of col) {
    if (await ops.paneExists(p)) alive.push(p);
  }

  if (alive.length) columns.set(parentPaneId, alive);
  else columns.delete(parentPaneId);
  return alive;
}

/** Test seam: drop all tracked columns. */
export function resetColumns(): void {
  columns.clear();
}

/** Test seam: inspect the tracked column for a parent pane. */
export function trackedColumn(parentPaneId: string): string[] {
  return [...(columns.get(parentPaneId) ?? [])];
}
