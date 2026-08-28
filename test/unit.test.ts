/**
 * Unit tests for the pure logic: agent definition parsing and session parsing.
 *
 * The herdr-facing paths are covered by the integration test, which needs a
 * live server. These run anywhere.
 */

import { strict as assert } from "node:assert";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { agentSearchPaths, loadAgents } from "../src/agents.ts";
import { findSessionFile, lastAssistantMessage, truncateResult } from "../src/session.ts";

function tempProject(): string {
  const dir = mkdtempSync(join(tmpdir(), "herdr-sub-test-"));
  mkdirSync(join(dir, ".pi", "agents"), { recursive: true });
  return dir;
}

function writeAgent(dir: string, name: string, content: string): void {
  writeFileSync(join(dir, ".pi", "agents", `${name}.md`), content, "utf8");
}

test("parses a well-formed agent definition", () => {
  const dir = tempProject();
  writeAgent(
    dir,
    "probe",
    `---
description: A probe
tools: read, grep
model: anthropic/claude-sonnet-5
thinking: high
---
Body text here.`,
  );

  const { agents, errors } = loadAgents(dir);
  assert.equal(errors.length, 0);
  const a = agents.get("probe");
  assert.ok(a);
  assert.equal(a.description, "A probe");
  assert.deepEqual(a.tools, ["read", "grep"]);
  assert.equal(a.model, "anthropic/claude-sonnet-5");
  assert.equal(a.thinking, "high");
  assert.equal(a.body, "Body text here.");
  rmSync(dir, { recursive: true, force: true });
});

test("REFUSES an agent with no tools field", () => {
  // The whole point of the fail-closed rule: a missing allowlist must not
  // silently produce a fully-privileged agent.
  const dir = tempProject();
  writeAgent(dir, "unsafe", `---\ndescription: No tools declared\n---\nBody.`);

  const { agents, errors } = loadAgents(dir);
  assert.equal(agents.has("unsafe"), false, "agent must not be loadable");
  assert.equal(errors.length, 1);
  assert.match(errors[0], /has no "tools:" field/);
  rmSync(dir, { recursive: true, force: true });
});

test("refuses an agent with an empty tools list", () => {
  const dir = tempProject();
  writeAgent(dir, "empty", `---\ndescription: Empty\ntools:   \n---\nBody.`);
  const { agents, errors } = loadAgents(dir);
  assert.equal(agents.has("empty"), false);
  assert.match(errors[0], /has no "tools:" field/);
  rmSync(dir, { recursive: true, force: true });
});

test("refuses an invalid thinking level", () => {
  const dir = tempProject();
  writeAgent(dir, "bad", `---\ndescription: Bad\ntools: read\nthinking: ludicrous\n---\nBody.`);
  const { agents, errors } = loadAgents(dir);
  assert.equal(agents.has("bad"), false);
  assert.match(errors[0], /invalid thinking/);
  rmSync(dir, { recursive: true, force: true });
});

test("refuses an agent with no description", () => {
  const dir = tempProject();
  writeAgent(dir, "nodesc", `---\ntools: read\n---\nBody.`);
  const { agents, errors } = loadAgents(dir);
  assert.equal(agents.has("nodesc"), false);
  assert.match(errors[0], /no "description:" field/);
  rmSync(dir, { recursive: true, force: true });
});

test("one broken definition does not hide the valid ones", () => {
  const dir = tempProject();
  writeAgent(dir, "good", `---\ndescription: Good\ntools: read\n---\nBody.`);
  writeAgent(dir, "broken", `---\ndescription: Broken\n---\nBody.`);
  const { agents, errors } = loadAgents(dir);
  assert.ok(agents.has("good"), "valid agent still loads");
  assert.equal(agents.has("broken"), false);
  assert.equal(errors.length, 1);
  rmSync(dir, { recursive: true, force: true });
});

test("de-duplicates and trims the tool list", () => {
  const dir = tempProject();
  writeAgent(dir, "dupes", `---\ndescription: D\ntools: read,  grep ,read,find\n---\nB.`);
  const { agents } = loadAgents(dir);
  assert.deepEqual(agents.get("dupes")?.tools, ["read", "grep", "find"]);
  rmSync(dir, { recursive: true, force: true });
});

test("this extension bundles no agents of its own", () => {
  // Definitions are user configuration and live in the user's dotfiles, not
  // vendored here. An empty project must therefore discover nothing from the
  // package itself - only whatever the user has installed globally.
  const dir = tempProject();
  const { agents } = loadAgents(dir);
  const searchedHere = agentSearchPaths(dir).some((p) => p.includes("herdr-subagents"));
  assert.equal(searchedHere, false, "must not search a bundled agents dir");
  // Anything found came from the user's global dir, never from this package.
  for (const a of agents.values()) {
    assert.ok(
      a.source.includes(join(".pi", "agent", "agents")) || a.source.includes(dir),
      `unexpected agent source: ${a.source}`,
    );
  }
  rmSync(dir, { recursive: true, force: true });
});

test("a project definition overrides a global one of the same name", () => {
  const dir = tempProject();
  writeAgent(dir, "dup", `---\ndescription: Project copy\ntools: read\n---\nProject body.`);
  const { agents } = loadAgents(dir);
  const a = agents.get("dup");
  assert.equal(a?.description, "Project copy");
  assert.ok(a?.source.startsWith(dir), "project path must win");
  rmSync(dir, { recursive: true, force: true });
});

test("extracts the last assistant message from a session file", () => {
  const dir = mkdtempSync(join(tmpdir(), "herdr-sess-"));
  const f = join(dir, "2026-01-01T00-00-00Z_abc.jsonl");
  writeFileSync(
    f,
    [
      JSON.stringify({ type: "session", id: "abc" }),
      JSON.stringify({ type: "message", message: { role: "user", content: [{ type: "text", text: "hi" }] } }),
      JSON.stringify({ type: "message", message: { role: "assistant", content: [{ type: "text", text: "first" }] } }),
      JSON.stringify({ type: "message", message: { role: "assistant", content: [{ type: "text", text: "FINAL" }] } }),
    ].join("\n"),
    "utf8",
  );
  assert.equal(lastAssistantMessage(f), "FINAL");
  assert.equal(findSessionFile(dir, "abc"), f);
  rmSync(dir, { recursive: true, force: true });
});

test("tolerates a torn final line while the child is still writing", () => {
  const dir = mkdtempSync(join(tmpdir(), "herdr-sess-"));
  const f = join(dir, "x_partial.jsonl");
  writeFileSync(
    f,
    JSON.stringify({ type: "message", message: { role: "assistant", content: [{ type: "text", text: "done" }] } }) +
      '\n{"type":"message","mess',
    "utf8",
  );
  assert.equal(lastAssistantMessage(f), "done");
  rmSync(dir, { recursive: true, force: true });
});

test("returns undefined when a session file has no assistant message", () => {
  const dir = mkdtempSync(join(tmpdir(), "herdr-sess-"));
  const f = join(dir, "y_none.jsonl");
  writeFileSync(f, JSON.stringify({ type: "session", id: "y" }), "utf8");
  assert.equal(lastAssistantMessage(f), undefined);
  rmSync(dir, { recursive: true, force: true });
});

test("findSessionFile returns undefined for a missing dir or id", () => {
  assert.equal(findSessionFile("/nonexistent-dir-xyz", "a"), undefined);
  const dir = mkdtempSync(join(tmpdir(), "herdr-sess-"));
  assert.equal(findSessionFile(dir, "nope"), undefined);
  rmSync(dir, { recursive: true, force: true });
});

test("truncateResult keeps short text and marks long text", () => {
  assert.equal(truncateResult("short"), "short");
  const long = "x".repeat(20_000);
  const out = truncateResult(long, 100);
  assert.ok(out.length < 400);
  assert.match(out, /truncated 19900 chars/);
});
