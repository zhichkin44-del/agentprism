# AgentPrism

**Context economics for AI coding agents.** See what your agent pays to re-read, what it carries
long after its last use, and when compacting would actually pay off. Local-first: your logs never
leave your machine.

![Context economics of a 3,000-call Claude Code session: the prompt split, call by call, into what is always needed, content in use, earlier thinking and content carried after its last use; compactions as recorded and as the rule would place them](docs/assets/context-report.jpg)

> Status: working prototype, not on npm yet. Claude Code is supported today. Install from source (below).

## Why

Coding agents re-send the whole conversation on every step. On 12 days of real multi-agent work we found
the following. Method, validation and caveats are in [docs/FINDINGS.md](docs/FINDINGS.md).

- **Most of the bill is re-reading the past.** In the main chain it is about 85% of the cost; the model's
  own answers are the smaller part. The accounting matches Claude Code's own cost records.
- **A real part of what is re-read is no longer used.** About a fifth of the prompt cost carries blocks
  after their last use, most of all command output. That is an upper bound.
- **When to compact has a robust answer.** A simple rule stays within a few percent of the exact optimum
  computed in hindsight, under every assumption about what forgetting costs. The rule: compact when the
  excess re-reading reaches the cost of one compaction. Fixed thresholds can be several times worse.

Usage counters tell you how much you spent; Claude Code's `/usage` tells you where. AgentPrism prices
every piece of context and tells you when compaction pays off. See
[how it compares](docs/COMPETITORS.md).

## Install

Requires Node.js 22.13 or newer.

```bash
git clone https://github.com/zhichkin44-del/AgentPrism.git
cd AgentPrism
npm install
npm run build
npm link -w packages/cli   # puts `agentprism` on your PATH
```

No build for a quick look: `npm run dev -- context` runs the CLI straight from source.

## Quick start

```bash
agentprism context                       # the latest session: what it carries, and when to compact
agentprism context "refactor" --html r.html   # a session by part of its title, plus an HTML report
agentprism context --watch               # follow a live session; prints advice as it grows
```

```
◆ AgentPrism  context economics  advisory: changes nothing
my long session · 2026-10-23 10:45 → 2026-10-27 10:13 · 3,009 calls · opus-5-5

Re-reading the prompt  $295 84.8% of $348 (main chain)
  always needed       $71.73  24.3%  █████···············  system, tools, summaries, your prompts
  content in use        $114  38.5%  ████████············
  after its last use   $74.4  25.2%  █████···············  upper bound: an oracle could drop it
  earlier thinking    $35.22  11.9%  ██··················  use not visible in logs

When to compact (ski-rental rule; price of forgetting $0.5 per compaction, --rho to change)
  as recorded                $348  6 compactions
  with the rule              $234  23 compactions
  exact optimum (hindsight)  $227  23 compactions
```

`--html` writes a single self-contained page that you can show to anyone. It holds numbers, dates, model
names and kinds of content only: no messages, paths, titles or ids. `--rho` is the price you put on what
a compaction makes the agent forget. It is a choice, not a measurement (yet).

## Commands

| Command                  | What you get                                                                               |
| ------------------------ | ------------------------------------------------------------------------------------------ |
| `agentprism context [s]` | context economics of a session; `--html` report, `--watch` live advice, `--rho` forgetting |
| `agentprism`             | spend headline, most expensive sessions, top findings                                      |
| `agentprism report`      | spend by project, model, day, session and prompt; cache savings; cost by token kind        |
| `agentprism findings`    | waste detectors with evidence, an estimated cost and a concrete fix for each finding       |
| `agentprism mark <name>` | remember the moment you changed something (CLAUDE.md, habit, model)                        |
| `agentprism compare`     | before vs after that mark (see the caveat below)                                           |
| `agentprism modules`     | loaded plugins, adapters and detectors                                                     |

Add `--json` to any command for scripts, `--plugin ./my-plugin.mjs` to load your own modules.

## How it works

- **Exact cost.** Every model call is priced from its token usage: input, output, cache reads, and cache
  writes by TTL. The price table is checked automatically against Claude Code's own cost records.
- **Context ledger.** The growth of the prompt between two calls is measured exactly. It is split between
  the blocks that entered it (tool output, file reads, the model's text and thinking) by weights fitted
  on real logs. Each block is priced on every later call that re-reads it.
- **Use.** A block counts as in use while later outputs reuse its rare identifiers or work on its file.
  On cases where use is certain (an edit proves the agent had read the text) this finds 98% of them.
- **Compaction rule.** A ski-rental rule compares accumulated excess re-reading with the cost of one
  compaction. For comparison, the exact optimum is computed by dynamic programming over the recorded
  session.

The research behind it, including negative results, is in [docs/RESEARCH.md](docs/RESEARCH.md). The
scripts that produced it are in [`research/`](research).

## Honest limits

- Costs are **API-equivalent estimates** at list prices. On a subscription they show relative weight,
  not a bill.
- "After its last use" is an **upper bound**. Use by meaning, without a shared identifier, is invisible.
  Dropping a block from the middle of a cached prompt is not free.
- **`compare` is not yet trustworthy on a mixed history.** A placebo study showed large apparent changes
  where nothing changed. A fix is planned: an adjusted estimator, intervals, and a switchback schedule.

## Privacy

Everything runs locally. The database in `~/.agentprism/` stores tokens, costs, tool names and their
targets (file paths, the start of a command line) and hashes. It does not store your prompts, answers or
file contents. Content is read from the logs only in memory, for the session being analysed.

## Status

Prototype. [Plan](docs/PLAN.md) · [Findings](docs/FINDINGS.md) · [Architecture](docs/ARCHITECTURE.md) ·
[Metrics and definitions](docs/METRICS.md)
