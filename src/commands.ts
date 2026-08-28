/**
 * Slash commands: `/subagents` and `/subagent`.
 *
 * The tools already cover the model's needs. These cover yours: checking what
 * agents exist, or dispatching one yourself, without having to ask the model
 * to call a tool on your behalf and burn a turn doing it.
 *
 * Output goes through `appendEntry` rather than `notify`, so a multi-line
 * listing renders properly in the transcript and does not enter LLM context.
 * `/subagents` is pure inspection; nothing about it belongs in the model's
 * conversation.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { loadAgents } from "./agents.ts";
import type { SubagentRegistry } from "./registry.ts";

export const REPORT_ENTRY = "herdr-subagents:report";

export interface ReportData {
  lines: string[];
}

/** Human-readable listing of available agents plus anything currently running. */
function report(cwd: string, registry: SubagentRegistry): string[] {
  const { agents, errors } = loadAgents(cwd);
  const lines: string[] = [];

  if (agents.size === 0) {
    lines.push(
      "No subagent definitions found.",
      "",
      "Add one as a .md file in .pi/agents/ (this project) or ~/.pi/agent/agents/ (global):",
      "",
      "  ---",
      "  description: Fast read-only codebase recon",
      "  tools: read, grep, find, ls",
      "  ---",
      "  You are a scout. Cite file:line for everything.",
      "",
      "The tools: line is required - an agent with no allowlist would inherit",
      "pi's full toolset including write and bash.",
    );
  } else {
    lines.push(`${agents.size} agent${agents.size === 1 ? "" : "s"} available:`, "");
    for (const a of [...agents.values()].sort((x, y) => x.name.localeCompare(y.name))) {
      lines.push(`  ${a.name}`);
      lines.push(`    ${a.description}`);
      lines.push(`    tools: ${a.tools.join(", ")}${a.model ? `   model: ${a.model}` : ""}`);
      lines.push("");
    }
  }

  const live = registry.all().filter((s) => s.state !== "finished" && s.state !== "failed");
  if (live.length) {
    lines.push(`Running now (${live.length}):`, "");
    for (const s of live) {
      const secs = Math.round((Date.now() - s.startedAt) / 1000);
      lines.push(`  ${s.name} (${s.agent})  ${s.state}  ${secs}s  pane ${s.paneId}`);
    }
    lines.push("");
  }

  if (errors.length) {
    lines.push("Definitions that failed to load:", "");
    for (const e of errors) for (const l of e.split("\n")) lines.push(`  ${l}`);
  }

  return lines;
}

/**
 * Hard-wrap one logical line to `max` columns.
 *
 * Breaks on whitespace when it can and mid-word when it cannot, so a long
 * unbroken token (a path, a URL) still cannot exceed the width and crash the
 * renderer. Continuation lines keep the original indent so wrapped agent
 * descriptions stay readable under their heading.
 */
export function wrap(line: string, max: number): string[] {
  if (line.length <= max) return [line];

  const indent = (line.match(/^\s*/)?.[0] ?? "") + "  ";
  const out: string[] = [];
  let rest = line;
  let width = max;

  while (rest.length > width) {
    let cut = rest.lastIndexOf(" ", width);
    if (cut <= indent.length) cut = width; // no usable space: break mid-word
    out.push(rest.slice(0, cut).trimEnd());
    rest = indent + rest.slice(cut).trimStart();
    width = max;
  }
  if (rest.trim()) out.push(rest);
  return out;
}

export function registerCommands(pi: ExtensionAPI, registry: SubagentRegistry): void {
  /**
   * Renders the listing in the transcript without sending it to the model.
   *
   * Every line MUST be truncated to the width pi passes in. A renderer that
   * returns a line wider than the terminal does not clip - it takes the whole
   * TUI down with `Rendered line N exceeds terminal width`, which is an
   * uncaught exception that exits pi. Learned by crashing it.
   */
  pi.registerEntryRenderer?.(
    REPORT_ENTRY,
    (
      entry: { data?: unknown },
      _opts: unknown,
      theme: { fg(role: string, s: string): string },
    ) => {
      const data = (entry.data ?? {}) as ReportData;
      return {
        invalidate() {},
        render: (width: number) => {
          const max = Math.max(10, (width ?? 80) - 1);
          return (data.lines ?? []).flatMap((line) => wrap(line, max)).map((l) => theme.fg("dim", l));
        },
      };
    },
  );

  pi.registerCommand("subagents", {
    description: "List available subagent definitions and any running subagents",
    handler: async (_args: string, ctx: { cwd: string; ui: { notify(m: string, t?: string): void } }) => {
      const lines = report(ctx.cwd, registry);
      try {
        pi.appendEntry?.(REPORT_ENTRY, { lines } satisfies ReportData);
      } catch {
        // No transcript to write to (print/json mode): fall back to a notice.
        ctx.ui.notify(lines.join("\n"), "info");
      }
    },
  });

  pi.registerCommand("subagent", {
    description: "Dispatch a subagent yourself: /subagent <agent> <task>",
    // Completes the agent name, which is the part worth not mistyping.
    getArgumentCompletions: (prefix: string) => {
      // Only complete the first word; after that the user is writing a task.
      if (prefix.includes(" ")) return null;
      const { agents } = loadAgents(process.cwd());
      const items = [...agents.values()]
        .filter((a) => a.name.startsWith(prefix))
        .map((a) => ({ value: a.name, label: `${a.name} - ${a.description}` }));
      return items.length ? items : null;
    },
    handler: async (
      args: string,
      ctx: {
        cwd: string;
        ui: { notify(m: string, t?: string): void };
      },
    ) => {
      const trimmed = (args ?? "").trim();
      const sep = trimmed.indexOf(" ");
      const agent = sep === -1 ? trimmed : trimmed.slice(0, sep);
      const task = sep === -1 ? "" : trimmed.slice(sep + 1).trim();

      if (!agent || !task) {
        ctx.ui.notify(
          "Usage: /subagent <agent> <task>\nRun /subagents to see what is available.",
          "warning",
        );
        return;
      }

      const { agents } = loadAgents(ctx.cwd);
      if (!agents.has(agent)) {
        const known = [...agents.keys()].sort().join(", ") || "(none)";
        ctx.ui.notify(`Unknown agent "${agent}". Available: ${known}`, "error");
        return;
      }

      // Routed through the model rather than calling the tool directly: the
      // subagent's report needs to land in the conversation, and the model
      // should see the result it is about to reason over.
      await pi.sendUserMessage?.(
        `Use the subagent tool with agent="${agent}" and task=${JSON.stringify(task)}. ` +
          `Report its findings.`,
      );
    },
  });
}
