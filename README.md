# AgentPrism

**Devtools for AI coding agents.** See where your tokens go, find what cost money for nothing,
fix it, and prove the fix worked.

```bash
npx agentprism
```

> Work in progress. Claude Code is supported today; your own AI products (SDK) and other agents are next.
> Not on npm yet: until the first release, install from source (below).

## Install

Requires Node.js 22.13 or newer.

```bash
git clone https://github.com/zhichkin44-del/AgentPrism.git
cd AgentPrism
npm install
npm run build
npm link -w packages/cli   # puts `agentprism` on your PATH
agentprism                 # reads your Claude Code logs from ~/.claude/projects
```

No build step for a quick look: `npm run dev -- report` runs the CLI straight from source.
Everything stays on your machine; the database lives in `~/.agentprism/`.

## Why

Usage counters tell you **how much** you spent. AgentPrism tells you **why**, **what to change**, and
**whether it worked**. On the author's own month of Claude Code work it found that ~60% of the
API-equivalent spend came from session length — history re-read on every call and caches rebuilt after
breaks — not from the tools or the code.

## Commands

| Command                  | What you get                                                                        |
| ------------------------ | ----------------------------------------------------------------------------------- |
| `agentprism`             | spend headline, most expensive sessions, top findings                               |
| `agentprism report`      | spend by project, model, day, session and prompt; cache savings; cost by token kind |
| `agentprism findings`    | waste detectors with evidence, estimated cost and a concrete fix for each finding   |
| `agentprism mark <name>` | remember the moment you changed something (CLAUDE.md, habit, model)                 |
| `agentprism compare`     | before vs after that mark, per-session medians                                      |
| `agentprism modules`     | loaded plugins, adapters and detectors                                              |

Add `--json` to any command for scripts, `--plugin ./my-plugin.mjs` to load your own modules.

## Your own AI products

```ts
import { agentprism } from "@agentprism/sdk";

const prism = agentprism({ app: "support-bot" });
const client = prism.instrument(new Anthropic()); // every call traced locally
await prism.withAgent("triage", () => client.messages.create({ ... }));
```

The same reports and detectors then cover your app: spend per app and agent, latency, uncached prompts,
unstable prompt prefixes, duplicate requests. Runtime modules (router, cache, guards) plug into the same
call path. Format: [docs/TRACE_FORMAT.md](docs/TRACE_FORMAT.md).

## Detectors

Coding agents: context growth · cache rebuilds · oversized tool outputs · loops · failing tools ·
repeated file reads · rediscovered files · permission friction.
Your apps: uncached prompts · unstable prompt prefix · duplicate requests. How each one estimates waste: [docs/METRICS.md](docs/METRICS.md).

## Principles

Local-first and private · zero config · zero runtime dependencies · every feature is a module ·
honest numbers (API-equivalent estimates, capped, documented).

## Status

[Vision](docs/VISION.md) · [Roadmap](docs/ROADMAP.md) · [Current plan](docs/PLAN.md)
