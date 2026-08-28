/**
 * Reading a subagent's result out of its pi session file.
 *
 * The obvious approach is `herdr agent read`, but that returns rendered
 * terminal output: soft wraps, box drawing, status lines, and whatever
 * scrolled off the alternate screen. Herdr's own docs acknowledge the limit,
 * suggesting a file-based fallback when a response cannot be recovered from
 * the pane.
 *
 * So the child is launched with an explicit `--session-dir` and `--session-id`
 * and we read the JSONL it writes. That gives the assistant's exact final
 * message with no terminal artifacts, at any length.
 */

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Locate a session file by the id we assigned at spawn.
 *
 * pi names files `<timestamp>_<session-id>.jsonl`, so match on suffix rather
 * than predicting the timestamp.
 */
export function findSessionFile(sessionDir: string, sessionId: string): string | undefined {
  if (!existsSync(sessionDir)) return undefined;
  let entries: string[];
  try {
    entries = readdirSync(sessionDir);
  } catch {
    return undefined;
  }
  const match = entries
    .filter((f) => f.endsWith(`_${sessionId}.jsonl`) || f === `${sessionId}.jsonl`)
    .sort();
  const last = match[match.length - 1];
  return last ? join(sessionDir, last) : undefined;
}

/**
 * The last assistant text in a session file, which is the agent's summary of
 * its own work and the thing worth handing back to the parent.
 *
 * Tolerates partial writes: the child may still be flushing when we read, so
 * unparseable trailing lines are skipped rather than treated as failure.
 */
export function lastAssistantMessage(sessionFile: string): string | undefined {
  let raw: string;
  try {
    raw = readFileSync(sessionFile, "utf8");
  } catch {
    return undefined;
  }

  let result: string | undefined;
  for (const line of raw.split("\n")) {
    const t = line.trim();
    if (!t) continue;
    let entry: unknown;
    try {
      entry = JSON.parse(t);
    } catch {
      continue; // torn final line while the child is still writing
    }
    const msg = (entry as { message?: { role?: string; content?: unknown[] } }).message;
    if (msg?.role !== "assistant" || !Array.isArray(msg.content)) continue;

    const text = msg.content
      .filter((c): c is { type: string; text: string } => {
        const b = c as { type?: string; text?: unknown };
        return b?.type === "text" && typeof b.text === "string";
      })
      .map((c) => c.text)
      .join("\n")
      .trim();

    if (text) result = text;
  }
  return result;
}

/** Trim a result to a sane size before it re-enters the parent's context. */
export function truncateResult(text: string, maxChars = 12_000): string {
  if (text.length <= maxChars) return text;
  const head = text.slice(0, maxChars);
  return `${head}\n\n[... truncated ${text.length - maxChars} chars. Full transcript in the subagent's session file.]`;
}
