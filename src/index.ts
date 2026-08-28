/**
 * herdr-subagents: async subagents for pi, running in herdr panes.
 *
 * `subagent()` returns immediately. The child runs in its own herdr pane, and
 * when it settles its result is injected back into this session as a new
 * message, so the parent can keep working while it runs.
 *
 * Why herdr rather than a terminal multiplexer: herdr already classifies every
 * pane occupant as idle / working / blocked / done and pushes those
 * transitions over its socket. Completion detection is therefore an event
 * subscription, not screen-scraping, and `blocked` gives us a real signal for
 * "this agent is stuck on an approval prompt".
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { Type } from "typebox";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

import { loadAgents, type AgentDef } from "./agents.ts";
import {
  closePane,
  getAgent,
  insideHerdr,
  listAgents,
  promptAgent,
  splitPane,
  startAgent,
  HerdrError,
} from "./herdr.ts";
import { SubagentRegistry, type Subagent } from "./registry.ts";
import { findSessionFile, lastAssistantMessage, truncateResult } from "./session.ts";

/**
 * Extensions the child must keep even though it is launched with
 * `--no-extensions`.
 *
 * This is not optional polish. Measured on 2026-08-28: a child started with a
 * bare `--no-extensions` loses `anthropic-subscription-fix.ts` and dies on the
 * first turn with `400 "You're out of extra usage"`. `guards` is re-added for
 * the same reason it exists in the parent - a subagent with `bash` must not be
 * able to run `git reset --hard` unchallenged.
 */
const REQUIRED_EXTENSIONS = [
  join(homedir(), "dotfiles", ".pi", "agent", "extensions", "anthropic-subscription-fix.ts"),
  join(homedir(), "dotfiles", ".pi", "agent", "extensions", "guards"),
];

/** Where child session transcripts are written, so results can be read back. */
const SESSION_ROOT = join(homedir(), ".pi", "agent", "subagent-sessions");

const SUMMARY_INSTRUCTION = `

---
You are running as an autonomous subagent. Your FINAL message is the entire
report your caller receives - they cannot see your pane, your tool calls, or
your reasoning. Write it as a self-contained answer: what you found, where
(file:line), and what you concluded. No preamble, no "let me know if".`;

function slug(s: string): string {
  return (
    s
      .toLowerCase()
      .replace(/[^a-z0-9-]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 24) || "subagent"
  );
}

export default function (pi: ExtensionAPI) {
  const registry = new SubagentRegistry();

  /**
   * Deliver a finished subagent's result into the parent conversation.
   *
   * pi.sendMessage injects it as real context, so the model reacts to the
   * result on its next turn rather than the user having to relay it.
   */
  registry.onChange((s: Subagent) => {
    if (s.state !== "finished" && s.state !== "failed") return;
    if (s.delivered) return;
    s.delivered = true;

    if (s.state === "failed") {
      void pi.sendMessage(
        `[subagent ${s.name} FAILED] ${s.error ?? "unknown error"}\n` +
          `Its pane (${s.paneId}) is still open if you want to inspect it.`,
      );
      return;
    }

    const file = findSessionFile(s.sessionDir, s.sessionId);
    const text = file ? lastAssistantMessage(file) : undefined;
    s.result = text;

    if (!text) {
      void pi.sendMessage(
        `[subagent ${s.name} finished but produced no readable result]\n` +
          `Session: ${file ?? s.sessionDir}\nPane: ${s.paneId}`,
      );
      return;
    }

    const secs = Math.round(((s.finishedAt ?? Date.now()) - s.startedAt) / 1000);
    void pi.sendMessage(
      `[subagent ${s.name} (${s.agent}) finished in ${secs}s]\n\n` +
        `Task: ${s.task}\n\n${truncateResult(text)}`,
    );
  });

  pi.registerTool({
    name: "subagent",
    label: "Spawn subagent",
    description:
      "Spawn an autonomous subagent in its own herdr pane. Returns immediately - " +
      "the subagent runs in parallel and its result is delivered back into this " +
      "conversation when it finishes. Use subagents_list to see available agents.",
    promptSnippet: "Spawn an async subagent in a herdr pane (non-blocking)",
    promptGuidelines: [
      "Use subagent for self-contained, parallelizable work whose intermediate output you would never re-read - recon, and independent verification.",
      "A subagent cannot see this conversation: the task string is everything it gets, so make it self-contained.",
      "subagent returns before the work is done. Keep working; the result arrives as a later message.",
    ],
    parameters: Type.Object({
      agent: Type.String({
        description: "Agent definition to run. Use subagents_list to see what exists.",
      }),
      task: Type.String({
        description:
          "Self-contained task prompt. The subagent sees only this, not the current conversation.",
      }),
      name: Type.Optional(
        Type.String({
          description: "Display name for the pane. Defaults to the agent name; duplicates get -2, -3.",
        }),
      ),
      cwd: Type.Optional(
        Type.String({ description: "Working directory. Defaults to the current one." }),
      ),
    }),

    async execute(_id, params, _signal, _onUpdate, ctx: ExtensionContext) {
      if (!insideHerdr()) {
        return {
          content: [
            {
              type: "text" as const,
              text:
                "Not running inside herdr (HERDR_ENV is unset), so there is no pane to " +
                "split. Start pi inside a herdr session and try again.",
            },
          ],
          isError: true,
        };
      }

      const { agents, errors } = loadAgents(ctx.cwd);
      const def: AgentDef | undefined = agents.get(params.agent);
      if (!def) {
        const known = [...agents.keys()].sort().join(", ") || "(none)";
        return {
          content: [
            {
              type: "text" as const,
              text:
                `Unknown agent "${params.agent}". Available: ${known}` +
                (errors.length ? `\n\nDefinitions that failed to load:\n${errors.join("\n")}` : ""),
            },
          ],
          isError: true,
        };
      }

      const name = registry.uniqueName(params.name ? slug(params.name) : def.name);
      const cwd = params.cwd ?? ctx.cwd;
      const sessionDir = join(SESSION_ROOT, name);
      const sessionId = `${name}-${Date.now()}`;
      mkdirSync(sessionDir, { recursive: true });

      // The system prompt goes in a FILE, not on the command line.
      //
      // Herdr rejects any agent argument it cannot encode safely for the
      // target shell, and a multi-line value trips that: `agent start` fails
      // with `invalid_agent_argument`. Since every useful agent body spans
      // several lines, passing it inline is not viable. pi's
      // `--append-system-prompt` accepts "text or file contents", so a path
      // sidesteps the encoding limit entirely and keeps the argument a single
      // shell-safe token.
      const promptFile = join(sessionDir, `${sessionId}.system.md`);
      writeFileSync(promptFile, def.body + SUMMARY_INSTRUCTION, "utf8");

      // Default-deny sandbox: no discovered extensions, an explicit tool
      // allowlist, and only the extensions we deliberately add back.
      const piArgs = [
        "--session-dir", sessionDir,
        "--session-id", sessionId,
        "--no-extensions",
        "--tools", def.tools.join(","),
        "--append-system-prompt", promptFile,
      ];
      for (const ext of REQUIRED_EXTENSIONS) piArgs.push("-e", ext);
      if (def.model) piArgs.push("--model", def.model);
      if (def.thinking) piArgs.push("--thinking", def.thinking);

      let paneId: string;
      try {
        paneId = await splitPane({
          fromPaneId: process.env.HERDR_PANE_ID,
          direction: "right",
          cwd,
          env: { HERDR_SUBAGENT: name, HERDR_SUBAGENT_PARENT: process.env.HERDR_PANE_ID ?? "" },
        });
      } catch (err) {
        return errorResult(`Could not split a pane: ${msg(err)}`);
      }

      try {
        await startAgent({ name, paneId, piArgs, timeoutMs: 60_000 });
      } catch (err) {
        // Leave no orphan pane behind if the agent never came up.
        try {
          await closePane(paneId);
        } catch {
          /* best effort */
        }
        return errorResult(`Could not start pi in pane ${paneId}: ${msg(err)}`);
      }

      const sub: Subagent = {
        name,
        agent: def.name,
        task: params.task,
        paneId,
        sessionDir,
        sessionId,
        state: "starting",
        startedAt: Date.now(),
        delivered: false,
      };
      registry.add(sub);

      try {
        // Fire and forget: the registry's event watcher handles completion.
        await promptAgent({ target: name, text: params.task, wait: false });
      } catch (err) {
        registry.transition(name, "failed", { error: `prompt failed: ${msg(err)}` });
        return errorResult(`Started ${name} but could not prompt it: ${msg(err)}`);
      }

      return {
        content: [
          {
            type: "text" as const,
            text:
              `Spawned subagent "${name}" (${def.name}) in pane ${paneId}.\n` +
              `Tools: ${def.tools.join(", ")}\n` +
              `It is running now; its result will arrive here when it finishes. ` +
              `Continue with other work rather than waiting.`,
          },
        ],
        details: { name, agent: def.name, paneId, tools: def.tools },
      };
    },
  });

  pi.registerTool({
    name: "subagents_list",
    label: "List subagents",
    description:
      "List available subagent definitions and the status of any currently running subagents.",
    promptSnippet: "List available subagent types and running subagents",
    parameters: Type.Object({}),
    async execute(_id, _params, _signal, _onUpdate, ctx: ExtensionContext) {
      const { agents, errors } = loadAgents(ctx.cwd);
      const lines: string[] = ["Available agents:"];
      if (agents.size === 0) lines.push("  (none found)");
      for (const a of [...agents.values()].sort((x, y) => x.name.localeCompare(y.name))) {
        lines.push(`  ${a.name} - ${a.description}`);
        lines.push(`      tools: ${a.tools.join(", ")}${a.model ? ` | model: ${a.model}` : ""}`);
      }

      const live = registry.all();
      if (live.length) {
        lines.push("", "Subagents this session:");
        for (const s of live) {
          const secs = Math.round(((s.finishedAt ?? Date.now()) - s.startedAt) / 1000);
          lines.push(`  ${s.name} (${s.agent}) - ${s.state} - ${secs}s - pane ${s.paneId}`);
        }
      }

      if (errors.length) {
        lines.push("", "Definitions that failed to load:", ...errors.map((e) => `  ${e}`));
      }

      return { content: [{ type: "text" as const, text: lines.join("\n") }] };
    },
  });

  pi.registerTool({
    name: "subagent_status",
    label: "Subagent status",
    description:
      "Check a running subagent's live state, or read what it has produced so far without waiting for it to finish.",
    promptSnippet: "Check a running subagent's state",
    parameters: Type.Object({
      name: Type.String({ description: "Subagent name, as returned by subagent." }),
    }),
    async execute(_id, params) {
      const s = registry.get(params.name);
      if (!s) {
        const known = registry.all().map((a) => a.name).join(", ") || "(none)";
        return errorResult(`No subagent named "${params.name}". Known: ${known}`);
      }

      let liveStatus = "unknown";
      try {
        liveStatus = (await getAgent(s.name)).agent_status ?? "unknown";
      } catch {
        /* the pane may already be gone */
      }

      const file = findSessionFile(s.sessionDir, s.sessionId);
      const partial = file ? lastAssistantMessage(file) : undefined;
      const secs = Math.round(((s.finishedAt ?? Date.now()) - s.startedAt) / 1000);

      return {
        content: [
          {
            type: "text" as const,
            text:
              `${s.name} (${s.agent})\n` +
              `  tracked state: ${s.state}\n  herdr status:  ${liveStatus}\n` +
              `  pane: ${s.paneId}\n  elapsed: ${secs}s\n` +
              (partial ? `\nLatest output:\n${truncateResult(partial, 4000)}` : "\n(no output yet)"),
          },
        ],
      };
    },
  });

  pi.registerTool({
    name: "subagent_message",
    label: "Message subagent",
    description:
      "Send a follow-up message to a running subagent, for example to redirect or add context. " +
      "Returns immediately; the subagent picks it up at its next turn boundary.",
    promptSnippet: "Send a follow-up message to a running subagent",
    parameters: Type.Object({
      name: Type.String({ description: "Subagent name." }),
      message: Type.String({ description: "Message to send." }),
    }),
    async execute(_id, params) {
      const s = registry.get(params.name);
      if (!s) {
        const known = registry.all().map((a) => a.name).join(", ") || "(none)";
        return errorResult(`No subagent named "${params.name}". Known: ${known}`);
      }
      if (s.state === "finished" || s.state === "failed") {
        return errorResult(
          `Subagent "${params.name}" has already ${s.state}. Spawn a new one rather than reviving it.`,
        );
      }
      try {
        await promptAgent({ target: s.name, text: params.message, wait: false });
      } catch (err) {
        const code = err instanceof HerdrError ? err.code : undefined;
        if (code === "agent_blocked") {
          return errorResult(
            `Subagent "${params.name}" is blocked on an approval prompt and cannot accept input. ` +
              `Inspect pane ${s.paneId} and ask the user before answering it.`,
          );
        }
        return errorResult(`Could not message "${params.name}": ${msg(err)}`);
      }
      return {
        content: [{ type: "text" as const, text: `Message delivered to ${params.name}.` }],
      };
    },
  });

  // Surface orphans from a previous run rather than pretending they are ours.
  pi.on("session_start", async () => {
    if (!insideHerdr()) return;
    try {
      await listAgents();
    } catch {
      /* herdr may not be reachable; the tools report that when used */
    }
  });

  pi.on("session_shutdown", async () => {
    registry.dispose();
  });
}

function msg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function errorResult(text: string) {
  return { content: [{ type: "text" as const, text }], isError: true };
}
