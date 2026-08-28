/**
 * Resolve pi's own path helpers, with a fallback.
 *
 * `@earendil-works/pi-coding-agent` is a peer dependency: pi injects it when
 * it loads an extension, so the import works at runtime without the package
 * being installed here. Plain `node --test` has no such injection, and a bare
 * top-level import would make the whole suite unrunnable in a fresh checkout.
 *
 * So the import is attempted and falls back to the documented defaults. That
 * keeps `getAgentDir()` authoritative in the environment that matters - it
 * honours `PI_CODING_AGENT_DIR`, which a hardcoded `~/.pi` silently ignores -
 * while leaving the tests runnable anywhere.
 */

import { homedir } from "node:os";
import { join } from "node:path";

interface PiPaths {
  /** e.g. `.pi` - the project-local config directory name. */
  configDirName: string;
  /** e.g. `~/.pi/agent` - honours PI_CODING_AGENT_DIR when pi provides it. */
  agentDir: string;
}

function fallback(): PiPaths {
  // Mirrors pi's own defaults, including the env override it documents.
  const agentDir =
    process.env.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "agent");
  return { configDirName: ".pi", agentDir };
}

let cached: PiPaths | undefined;

export function piPaths(): PiPaths {
  if (cached) return cached;
  cached = fallback();
  return cached;
}

/**
 * Upgrade to pi's real helpers when the host package is resolvable.
 *
 * Called once at extension load. Failure is expected outside pi and is not an
 * error: the fallback already matches pi's documented layout.
 */
export async function adoptPiPaths(): Promise<void> {
  try {
    const mod = (await import("@earendil-works/pi-coding-agent")) as {
      CONFIG_DIR_NAME?: string;
      getAgentDir?: () => string;
    };
    if (mod.CONFIG_DIR_NAME && mod.getAgentDir) {
      cached = { configDirName: mod.CONFIG_DIR_NAME, agentDir: mod.getAgentDir() };
    }
  } catch {
    // Not running under pi; the fallback stands.
  }
}
