# Plan — v0.1 "Useful in the terminal"

Direction (D14–D16): terminal first, everything is a module, usefulness before polish.
The web app waits until the analysis is genuinely useful. Long-term items live in `ROADMAP.md`.
Status markers: `[ ]` todo, `[~]` in progress, `[x]` done.

## M0 — Setup and product definition

- [x] Idea, goal, vision, roadmap, launch plan, name (AgentPrism)
- [x] Log format reverse-engineered on real data (`LOG_FORMAT.md`)
- [x] Working docs, git init
- [x] First commit and private GitHub repo

## M1 — Foundation

- [x] npm workspaces monorepo: `core`, `adapter-claude-code`, `cli`; TypeScript strict, vitest, eslint, prettier
- [x] Normalized schema (OTel GenAI-aligned) and plugin interfaces
- [x] Claude Code adapter: streaming, tolerant, global de-duplication, subagents, image-aware sizes
- [x] SQLite store (`node:sqlite`), incremental idempotent ingest
- [x] CI workflow (Linux/macOS/Windows × Node 22/24) — not run yet, no remote

## M2 — Money

- [x] Price table with long-prompt tiers and local overrides (`~/.agentprism/prices.json`)
- [x] `ap_cost()` registered in SQL; cost split into input / output / cache read / cache write
- [x] `agentprism report`: projects, models, days, most expensive sessions and prompts, cache savings
- [x] Baseline captured in `METRICS.md`

## M3 — Waste detectors (modules)

- [x] Module system: `Plugin`, `Registry`, `--plugin <path|package>`, `agentprism modules`
- [x] Detectors: context growth, cache rebuilds, oversized outputs, loops, failing tools,
      repeated reads, rediscovered files, permission friction
- [x] `agentprism findings` with evidence, estimated waste and a concrete suggestion per finding
- [x] Waste estimates capped so no finding exceeds what its session actually cost

## M4 — Prove it (closed loop)

- [x] `agentprism mark "<what changed>"` and `agentprism compare` (before vs after, per-session medians)
- [x] Split by call time instead of session start (turn-level estimator, D29)
- [ ] Apply the top suggestions to the author's own workflow, mark it, re-measure after a week
- [ ] Before/after table in `METRICS.md` and README

## M5 — SDK: measure your own products and agent systems (v0.2)

- [x] AgentPrism trace format v1 (JSONL), documented in `docs/TRACE_FORMAT.md`
- [x] `@agentprism/sdk`: `instrument(client, { app })` for Anthropic clients — `messages.create`
      (plain and `stream: true`) and `messages.stream()`; zero dependencies (D20)
- [x] Middleware pipeline (`before` / `after` / `onError`) — the slot for router, cache and guards
- [x] Sessions, agents and steps: `withSession`, `agent` names, parent agents for multi-agent systems
- [x] Capture modes: hashes by default, text opt-in (D21)
- [x] Trace adapter: SDK traces in the same store; `report` / `findings` work on them
- [x] Agent analytics: spend and calls per agent and per step
- [x] Product detectors: unstable prompt prefixes (cache misses), retries/errors, oversized prompts

Still open in M5: OpenAI client support; OpenTelemetry GenAI importer; SDK build for npm (exports point at
TypeScript sources inside the monorepo today).

## M6 — Simulate (v0.3)

- [ ] Routing what-if · semantic-cache what-if · prompt-cache what-if · context what-if

## M7 — Guard (v0.4)

- [ ] Evals module (datasets from traces, graders, LLM judge, regression runs)
- [ ] Groundedness / hallucination checks; online sampling

## M8 — Optimize (v0.5)

- [ ] Router · semantic cache · context trimming · budgets — as SDK middleware modules

## M9 — Ship

- [ ] README with real before/after numbers, terminal GIF, install
- [ ] npm publish (`agentprism`, `@agentprism/sdk`), GitHub release, CI green on all OSes
- [ ] Launch per `LAUNCH.md`

## Later

- Fix modules (CLAUDE.md / permission patches), more coding-agent adapters
- Web app over the same modules and JSON

## M10 — Context economics (advisor)

Direction from the owner (2026-11-04): research first, then a technology nobody has. Evidence in `RESEARCH.md`.

- [x] Research R1 (dead context), R2 (when to compact), Q1 (price of forgetting), R4 (negative)
- [x] Adapter `timeline()`: one session's content on demand, never stored (D27)
- [x] Core: context ledger (cost and use of every block) and the ski-rental compaction advisor with the
      exact optimum for comparison
- [x] `agentprism context [session] [--rho] [--html]`: terminal report plus an anonymized HTML report
- [ ] Owner labels 60 sampled pairs: precision of correction detection, gold data for the owner's voice

- [ ] A measured price of forgetting, to replace the chosen `--rho`
- [x] R3 placebo study (shipped `compare` not trustworthy on mixed histories; switchback design)
- [x] `--watch`: live advice on a running session
- [x] `compare` rebuilt: adjusted effect, interval, noise floor, verdict; `switchback` schedules (D29)
