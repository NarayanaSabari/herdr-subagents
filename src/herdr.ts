/**
 * herdr CLI wrapper.
 *
 * Everything this extension does to the outside world goes through here, as
 * argv arrays via execFile - never a shell string - so no task text, agent
 * name, or path can be interpreted as shell syntax.
 *
 * Herdr's own plugin docs say "the entire Herdr CLI is the plugin API", and
 * HERDR_BIN_PATH points at the running binary when we are launched from a
 * herdr context, so prefer it over a bare `herdr` on PATH.
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const HERDR_BIN = process.env.HERDR_BIN_PATH || "herdr";

/** Herdr's agent lifecycle states, as reported by the server. */
export type AgentStatus = "idle" | "working" | "blocked" | "done" | "unknown";

export interface PaneInfo {
  pane_id: string;
  workspace_id?: string;
  tab_id?: string;
}

export interface AgentInfo {
  name?: string;
  agent?: string;
  agent_status?: AgentStatus;
  pane_id?: string;
  workspace_id?: string;
  tab_id?: string;
  state_change_seq?: number;
  interactive_ready?: boolean;
}

export class HerdrError extends Error {
  // Written as an explicit field rather than a constructor parameter property:
  // Node's built-in type stripper rejects `readonly code` in a parameter list
  // with ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX, and this package is loaded
  // directly from source by pi and by `node --test`, with no build step.
  readonly code?: string;

  constructor(message: string, code?: string) {
    super(message);
    this.name = "HerdrError";
    this.code = code;
  }
}

/**
 * Run a herdr CLI command and parse its JSON response.
 *
 * Herdr reports server errors as JSON on stderr with exit status 1, and CLI
 * syntax errors with status 2, so a non-zero exit is not automatically a
 * crash - we try to surface the structured error code when there is one.
 */
async function herdr<T = unknown>(args: string[], timeoutMs = 30_000): Promise<T> {
  let stdout: string;
  try {
    const res = await execFileAsync(HERDR_BIN, args, {
      encoding: "utf8",
      timeout: timeoutMs,
      maxBuffer: 32 * 1024 * 1024,
    });
    stdout = res.stdout;
  } catch (err: unknown) {
    const e = err as { stdout?: string; stderr?: string; message?: string };
    const payload = e.stdout || e.stderr || "";
    const parsed = tryParse(payload);
    const code = parsed?.error?.code;
    const msg = parsed?.error?.message || e.stderr?.trim() || e.message || "herdr command failed";
    throw new HerdrError(`${args.slice(0, 2).join(" ")}: ${msg}`, code);
  }

  const parsed = tryParse(stdout);
  if (!parsed) throw new HerdrError(`${args.slice(0, 2).join(" ")}: non-JSON response`);
  if (parsed.error) {
    throw new HerdrError(
      `${args.slice(0, 2).join(" ")}: ${parsed.error.message ?? "error"}`,
      parsed.error.code,
    );
  }
  return parsed.result as T;
}

function tryParse(s: string): { result?: unknown; error?: { code?: string; message?: string } } | null {
  const trimmed = (s || "").trim();
  if (!trimmed.startsWith("{")) return null;
  try {
    return JSON.parse(trimmed);
  } catch {
    return null;
  }
}

/** True when this process is running inside a herdr-managed pane. */
export function insideHerdr(): boolean {
  return process.env.HERDR_ENV === "1";
}

/** The pane this process is running in, when herdr injected it. */
export function callerPaneId(): string | undefined {
  return process.env.HERDR_PANE_ID || undefined;
}

/**
 * Split a pane and return the new pane's id.
 *
 * Always `--no-focus`: a background subagent must never steal the keyboard
 * from the person driving the parent session.
 */
export async function splitPane(opts: {
  fromPaneId?: string;
  direction: "right" | "down" | "left" | "up";
  cwd: string;
  ratio?: number;
  env?: Record<string, string>;
}): Promise<string> {
  const args = ["pane", "split"];
  if (opts.fromPaneId) args.push(opts.fromPaneId);
  else args.push("--current");
  args.push("--direction", opts.direction, "--cwd", opts.cwd, "--no-focus");
  if (opts.ratio !== undefined) args.push("--ratio", String(opts.ratio));
  for (const [k, v] of Object.entries(opts.env ?? {})) args.push("--env", `${k}=${v}`);

  const res = await herdr<{ pane: PaneInfo }>(args);
  const id = res?.pane?.pane_id;
  if (!id) throw new HerdrError("pane split returned no pane_id");
  return id;
}

/** Whether a pane is still open. Used before splitting from a tracked pane. */
export async function paneExists(paneId: string): Promise<boolean> {
  try {
    await herdr(["pane", "get", paneId], 10_000);
    return true;
  } catch {
    return false;
  }
}

/**
 * Create a tab and return its root pane.
 *
 * This is how subagents run without rearranging what you are looking at.
 * Splitting the caller's pane is unavoidably visible: every spawn takes space
 * from the pane you are reading, and four subagents leave the main view at a
 * quarter width. A tab is a whole separate screen, so the main pane keeps its
 * full size and the children are one keypress away instead of in the way.
 *
 * Always `--no-focus`: the tab is created behind you, never switched to.
 */
export async function createTab(opts: {
  cwd: string;
  label?: string;
  env?: Record<string, string>;
}): Promise<{ tabId: string; paneId: string }> {
  const args = ["tab", "create", "--cwd", opts.cwd, "--no-focus"];
  if (opts.label) args.push("--label", opts.label);
  for (const [k, v] of Object.entries(opts.env ?? {})) args.push("--env", `${k}=${v}`);

  const res = await herdr<{ tab?: { tab_id?: string }; root_pane?: PaneInfo }>(args);
  const paneId = res?.root_pane?.pane_id;
  if (!paneId) throw new HerdrError("tab create returned no root pane");
  return { tabId: res?.tab?.tab_id ?? res.root_pane?.tab_id ?? "", paneId };
}

/** Close a tab, once every subagent in it has finished. */
export async function closeTab(tabId: string): Promise<void> {
  await herdr(["tab", "close", tabId]);
}

/** Report the pane's layout, used to decide split direction. */
export async function paneLayout(paneId: string): Promise<unknown> {
  return herdr(["pane", "layout", "--pane", paneId]);
}

/**
 * Start a pi agent in an existing pane.
 *
 * Everything after `--` is passed verbatim to pi. Returns once herdr has
 * detected the agent and considers it ready for input; a startup block
 * surfaces as `agent_not_ready`.
 */
export async function startAgent(opts: {
  name: string;
  paneId: string;
  piArgs: string[];
  timeoutMs?: number;
}): Promise<AgentInfo> {
  const args = [
    "agent",
    "start",
    opts.name,
    "--kind",
    "pi",
    "--pane",
    opts.paneId,
    "--timeout",
    String(opts.timeoutMs ?? 60_000),
  ];
  if (opts.piArgs.length) args.push("--", ...opts.piArgs);

  const res = await herdr<{ agent: AgentInfo }>(args, (opts.timeoutMs ?? 60_000) + 15_000);
  return res.agent;
}

/**
 * Submit a prompt to a running agent.
 *
 * `wait: false` is the async path: herdr sends the text and returns, and the
 * caller watches the status stream for completion. Herdr refuses to prompt an
 * agent sitting at an approval dialog, returning `agent_blocked` before
 * sending anything.
 */
export async function promptAgent(opts: {
  target: string;
  text: string;
  wait?: boolean;
  timeoutMs?: number;
}): Promise<AgentInfo> {
  const args = ["agent", "prompt", opts.target, opts.text];
  if (opts.wait) args.push("--wait", "--timeout", String(opts.timeoutMs ?? 600_000));
  const res = await herdr<{ agent: AgentInfo }>(
    args,
    opts.wait ? (opts.timeoutMs ?? 600_000) + 15_000 : 30_000,
  );
  return res.agent;
}

/** Current state of one agent. */
export async function getAgent(target: string): Promise<AgentInfo> {
  const res = await herdr<{ agent: AgentInfo }>(["agent", "get", target]);
  return res.agent;
}

/** All live agents in this herdr session. */
export async function listAgents(): Promise<AgentInfo[]> {
  const res = await herdr<{ agents: AgentInfo[] }>(["agent", "list"]);
  return res.agents ?? [];
}

/** Send logical keys (`esc`, `ctrl+c`) to an agent. */
export async function sendKeys(target: string, keys: string): Promise<void> {
  await herdr(["agent", "send-keys", target, keys]);
}

/**
 * Move the keyboard to a subagent's pane.
 *
 * The deliberate counterpart to spawning with `--no-focus`: focus is never
 * taken from the user, only ever given when they ask for it by pressing Enter
 * on a row. `herdr pane focus` moves by direction only, so this goes through
 * the agent target, which addresses the pane wherever the layout put it.
 */
export async function focusAgent(target: string): Promise<void> {
  await herdr(["agent", "focus", target]);
}

/** Close a pane. Only ever called on panes this extension created. */
export async function closePane(paneId: string): Promise<void> {
  await herdr(["pane", "close", paneId]);
}

/** Show a herdr notification. Best-effort: never throws. */
export async function notify(title: string, body?: string): Promise<void> {
  try {
    const args = ["notification", "show", title];
    if (body) args.push("--body", body);
    await herdr(args, 5_000);
  } catch {
    // A missed toast must never break a spawn.
  }
}
