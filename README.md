# herdr-subagents

Async subagents for [pi](https://github.com/badlogic/pi-mono), running in
[herdr](https://github.com/herdrdev/herdr) panes.

`subagent()` returns immediately. The child runs in its own herdr pane, and when
it finishes its result is injected back into the parent conversation. The parent
keeps working in the meantime.

## Why herdr

Herdr already knows what every pane is doing. It classifies each agent as
`idle`, `working`, `blocked`, or `done`, and pushes those transitions over its
socket API.

That removes the hardest part of a subagent system. Multiplexer-based
implementations have to infer completion by scraping rendered panes and writing
activity snapshots; here completion is an event subscription. `blocked` is
particularly valuable: it means herdr recognised an approval or question prompt,
so a stuck subagent is a first-class state rather than something you notice
because it went quiet.

## Requirements

- pi `>= 0.84`
- herdr `>= 0.8`
- pi must be running **inside** a herdr pane (`HERDR_ENV=1`). The tools refuse
  to run otherwise rather than failing obscurely.

## Install

Clone it and load `src/index.ts` as a pi extension, either with `-e` for one run:

```bash
pi -e /path/to/herdr-subagents/src/index.ts
```

or by symlinking it into pi's extension directory so it loads every session:

```bash
ln -s /path/to/herdr-subagents ~/.pi/agent/extensions/herdr-subagents
```

## Tools

| tool | purpose |
|------|---------|
| `subagent` | Spawn an agent in a new pane. Returns immediately. |
| `subagents_list` | Available agent definitions plus live subagent status. |
| `subagent_status` | One subagent's state, and its output so far. |
| `subagent_message` | Send a follow-up to a running subagent. |

## Agent definitions

**This package bundles no agents.** Definitions are prompts you tune over time,
which makes them configuration: they belong in your own version-controlled
config, not vendored inside a dependency. Bundling would also mean two copies of
the same agent name, where yours silently shadows the packaged one.

Definitions are `.md` files, discovered in this order (first match wins):

1. `.pi/agents/` in the project
2. `~/.pi/agent/agents/` globally

```markdown
---
description: Fast read-only codebase recon.
tools: read, grep, find, ls
model: anthropic/claude-sonnet-5
thinking: medium
---

You are a scout. You find things in a codebase and report exactly where they are.
Cite file:line for everything. You cannot write or run commands.
```

| field | required | meaning |
|-------|----------|---------|
| `description` | **yes** | Shown in `subagents_list`. |
| `tools` | **yes** | Tool allowlist. See below. |
| `model` | no | Model override. |
| `thinking` | no | `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, `max`. |

The Markdown body becomes the agent's system prompt.

### `tools` is mandatory, deliberately

An agent definition with no `tools:` field is a **hard error** and will not
load.

The obvious alternative - treat "no allowlist" as "no restriction" - means a
one-line typo silently produces an agent with pi's full toolset, including
`write` and `bash`. That is the opposite of what the file appears to say. Here,
forgetting the field costs you an error message instead of an unsandboxed agent.

## How a subagent is sandboxed

Each child is launched as:

```
pi --session-dir <dir> --session-id <id>
   --no-extensions
   --tools <allowlist from frontmatter>
   --append-system-prompt <agent body>
   -e <required extensions>
```

`--no-extensions` disables discovery, so the child gets nothing the parent
happens to have loaded. Only the tools in the definition are enabled, and only
explicitly re-added extensions come back.

### Required extensions

`REQUIRED_EXTENSIONS` in `src/index.ts` lists extensions the child keeps despite
`--no-extensions`. This is not optional polish. On the machine this was built
for, a child started with a bare `--no-extensions` loses the Anthropic
subscription fix and dies on its first turn with
`400 "You're out of extra usage"`.

**Edit that list for your setup.** It currently points at paths under
`~/dotfiles/.pi/agent/extensions/`. The general rule: re-add anything the child
genuinely cannot run without, plus your safety guards - a subagent with `bash`
should be at least as constrained as you are.

## Results

The child writes a session JSONL, and the extension reads its last assistant
message from that file rather than scraping the pane. Terminal output loses
content to soft wraps, box drawing, and the alternate screen; the session file
is exact and complete at any length.

That is why the agent body ends with an instruction that the final message *is*
the report. The caller sees that message and nothing else.

## Limits

- **One level.** A subagent has no spawning tools, so it cannot spawn further
  subagents.
- **No resume.** When a subagent finishes, it is done. Spawn a new one rather
  than reviving it.
- **Panes are left open** when a subagent completes, so you can read its work.
  Close them yourself.
- **pi only.** No path for running other agent CLIs as subagents, though herdr
  itself supports many.

## Prior art

The architecture - async spawn, results steered back, agents as frontmatter
`.md` files - comes from
[HazAT/pi-interactive-subagents](https://github.com/HazAT/pi-interactive-subagents)
and the tmux-only fork
[amosblomqvist/pi-interactive-subagents](https://github.com/amosblomqvist/pi-interactive-subagents).

This is a rewrite against herdr rather than a port, and it differs in three
deliberate ways:

1. **Completion is event-driven**, from herdr's agent lifecycle, instead of
   inferred from pane contents.
2. **`tools` is mandatory.** Upstream treats a missing allowlist as
   unrestricted, contradicting its own documentation.
3. **No `safe_bash`.** Upstream ships a regex denylist for dangerous commands;
   testing its 16 patterns against equivalent destructive commands showed 11
   getting through, including `rm -rf ~`. Use a real guard extension via
   `REQUIRED_EXTENSIONS` instead.

## Development

```bash
node --test test/*.test.ts
```

The unit tests cover definition parsing and session extraction, and need
neither pi nor herdr.

## License

MIT
