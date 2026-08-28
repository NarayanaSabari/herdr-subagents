/**
 * Agent definitions: `.md` files with YAML-ish frontmatter.
 *
 * Discovery order, first match wins:
 *   1. `.pi/agents/`            (project-local, overrides global)
 *   2. `~/.pi/agent/agents/`    (global)
 *
 * This extension deliberately bundles no agents. Definitions are prompts you
 * tune over time, which makes them configuration: they belong in the same
 * version-controlled place as the rest of your pi setup, not vendored inside
 * a dependency. Bundling would also create two copies of the same agent name
 * where the user's copy silently shadows the packaged one, so editing a file
 * would not obviously change behaviour.
 *
 * ## Why `tools` is mandatory
 *
 * The upstream tmux implementation treats a missing `tools:` field as "no
 * restriction", which hands the child pi's full toolset including write and
 * bash. Its README claims the opposite ("an agent gets exactly what its
 * frontmatter lists"), so a one-line typo silently produces the most
 * privileged possible agent while reading as the safest.
 *
 * Here a definition without `tools` is a hard error and the agent never
 * spawns. Forgetting the field costs you an error message, not an unsandboxed
 * agent with bash.
 */

import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join, basename } from "node:path";

import { piPaths } from "./pi-paths.ts";

export interface AgentDef {
  /** Agent name, from the filename. */
  name: string;
  /** One-line summary shown in `subagents_list`. */
  description: string;
  /** Mandatory tool allowlist, already trimmed and de-duplicated. */
  tools: string[];
  /** Model override, e.g. `anthropic/claude-sonnet-5`. */
  model?: string;
  /** Thinking level passed to pi. */
  thinking?: "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
  /** Markdown body: the agent's role, appended to pi's system prompt. */
  body: string;
  /** Where this definition was loaded from, for error messages. */
  source: string;
}

export class AgentDefError extends Error {}

/**
 * Search roots, highest priority first.
 *
 * Paths come from pi's own helpers rather than a hardcoded `~/.pi`:
 * `getAgentDir()` honours `PI_CODING_AGENT_DIR`, so an isolated or rebranded
 * config directory resolves correctly instead of silently reading the default
 * one, and `CONFIG_DIR_NAME` keeps the project-local directory in step with
 * whatever the distribution calls it.
 */
export function agentSearchPaths(cwd: string): string[] {
  const { configDirName, agentDir } = piPaths();
  return [join(cwd, configDirName, "agents"), join(agentDir, "agents")];
}

/**
 * Minimal frontmatter parser.
 *
 * Deliberately not a YAML dependency: the schema is a handful of scalar
 * fields, and a real YAML parser would accept nested structures this format
 * has no meaning for.
 */
function parseFrontmatter(raw: string): { fields: Record<string, string>; body: string } {
  if (!raw.startsWith("---")) return { fields: {}, body: raw.trim() };

  const end = raw.indexOf("\n---", 3);
  if (end === -1) return { fields: {}, body: raw.trim() };

  const head = raw.slice(3, end);
  const body = raw.slice(end + 4).trim();

  const fields: Record<string, string> = {};
  for (const line of head.split("\n")) {
    const t = line.trim();
    if (!t || t.startsWith("#")) continue;
    const i = t.indexOf(":");
    if (i === -1) continue;
    const key = t.slice(0, i).trim();
    let value = t.slice(i + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (key) fields[key] = value;
  }
  return { fields, body };
}

const VALID_THINKING = new Set(["off", "minimal", "low", "medium", "high", "xhigh", "max"]);

function parseAgentFile(path: string): AgentDef {
  const name = basename(path, ".md");
  const { fields, body } = parseFrontmatter(readFileSync(path, "utf8"));

  // Fail closed. See the module docstring for why this is an error and not a
  // permissive default.
  const rawTools = (fields.tools ?? "").trim();
  if (!rawTools) {
    throw new AgentDefError(
      `Agent "${name}" (${path}) has no "tools:" field.\n` +
        `Every agent must declare its tool allowlist explicitly - an agent with no ` +
        `restriction would inherit pi's full toolset including write and bash.\n` +
        `Add e.g.  tools: read, grep, find`,
    );
  }

  const tools = [...new Set(rawTools.split(",").map((t) => t.trim()).filter(Boolean))];
  if (tools.length === 0) {
    throw new AgentDefError(`Agent "${name}" (${path}) has an empty "tools:" list.`);
  }

  const thinking = fields.thinking?.trim();
  if (thinking && !VALID_THINKING.has(thinking)) {
    throw new AgentDefError(
      `Agent "${name}" (${path}) has invalid thinking "${thinking}". ` +
        `Expected one of: ${[...VALID_THINKING].join(", ")}`,
    );
  }

  const description = (fields.description ?? "").trim();
  if (!description) {
    throw new AgentDefError(`Agent "${name}" (${path}) has no "description:" field.`);
  }

  return {
    name,
    description,
    tools,
    model: fields.model?.trim() || undefined,
    thinking: (thinking as AgentDef["thinking"]) || undefined,
    body,
    source: path,
  };
}

/**
 * Load every discoverable agent definition.
 *
 * A malformed definition is reported through `errors` rather than thrown, so
 * one bad file cannot make every other agent unavailable. `subagents_list`
 * surfaces those errors so a broken agent is visible instead of silently
 * missing.
 */
export function loadAgents(cwd: string): { agents: Map<string, AgentDef>; errors: string[] } {
  const agents = new Map<string, AgentDef>();
  const errors: string[] = [];

  for (const dir of agentSearchPaths(cwd)) {
    if (!existsSync(dir)) continue;
    let entries: string[];
    try {
      entries = readdirSync(dir).filter((f) => f.endsWith(".md"));
    } catch {
      continue;
    }
    for (const file of entries.sort()) {
      const name = basename(file, ".md");
      if (agents.has(name)) continue; // higher-priority root already won
      try {
        agents.set(name, parseAgentFile(join(dir, file)));
      } catch (err) {
        errors.push(err instanceof Error ? err.message : String(err));
      }
    }
  }

  return { agents, errors };
}
