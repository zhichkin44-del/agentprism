# Decisions

Short records of settled choices. Format: context → decision → why. Newest at the bottom.
Re-open a decision only with a concrete reason, and record the change as a new entry.

## D1 — Project: AgentLens (2026-10-23)

Context: need a portfolio project that solves a real pain in daily AI work and attracts AI companies.
Decision: an analytics + optimization tool for AI coding-agent sessions.
Why: hits the three most-discussed pains (context, cost/limits, evals); the author has real data
(own logs, 5 products) and can show measured before/after results.

## D2 — Claude Code first, other agents later (2026-10-23)

Why: the data is already on disk and rich; one solid parser beats four shallow ones.

## D3 — TypeScript + Node for CLI, server and dashboard (2026-10-23)

Why: one language end to end; `npx agentlens` is the easiest install for the target audience.
Node 24 is available locally.

## D4 — Local-first, SQLite storage (2026-10-23)

Why: logs are private; ~400 MB of JSONL needs indexed queries, not re-parsing on every view.
Try built-in `node:sqlite` first (no native build step); fall back to `better-sqlite3` if it gets in the way.

## D5 — Costs are API-equivalent estimates (2026-10-23)

Why: many users are on subscriptions, so "real" cost is not in the logs per call.
Tokens × editable price table, labelled "API-equivalent". Cross-check against `cost-state.totalCostUSD`.

## D6 — Repo in English, chat in Russian (2026-10-23)

Why: public showcase for international companies.

## D7 — The OmniVoice brief stays private (2026-10-23)

It contains personal details. Moved to `_archive/`, which is gitignored.

## D8 — Ambition: a popular open-source devtool, not a personal script (2026-10-23)

Context: the user wants this to be a flagship project (target 1,000+ stars) that grows into a platform.
Decision: plugin architecture from day one, polished UI, launch plan. See VISION.md and ROADMAP.md.
v0.1 stays scoped to Claude Code so it ships within ~16 hours.

## D9 — Differentiate from usage counters (2026-10-23)

Context: ccusage (~10k stars) and many clones already count tokens.
Decision: counting is only the entry point; the product is "why → fix → proof", cross-agent comparison
and AI-code outcomes. Never pitch it as "another usage tracker".

## D10 — Name: AgentPrism (2026-10-23, confirmed by the user)

`agentlens` is taken on npm (placeholder package); `agentxray`, `tokentrail`, `agentscope` are taken by
similar tools. `agentprism` is free on npm. Metaphor: a prism splits an opaque session into its spectrum.
Supersedes the working name AgentLens.

## D11 — Shape: CLI + local web app, no Electron (2026-10-23)

`npx agentprism` scans, serves a local API and opens the browser.
Why: zero install, works on every OS, smallest footprint, web UI can be as beautiful as a desktop app.
A Tauri tray app / VS Code extension can wrap the same local server later.

## D12 — npm workspaces monorepo, single published package (2026-10-23)

Packages: core, adapter-claude-code, web, cli. Only `cli` is published and bundles the rest.
Why: clean plugin boundaries for future adapters, simple install for users.
npm workspaces instead of pnpm: no extra tool to install for contributors (pnpm was not even present locally).
Minimum Node version: 22.5 (needed for `node:sqlite`).

## D13 — Schema follows OpenTelemetry GenAI conventions (2026-10-23)

Why: universality and credibility; OTLP export to Grafana/Langfuse/Datadog becomes a mapping.

## D14 — Terminal first; web app deferred (2026-10-23)

Context: the user wants real usefulness before polish.
Decision: v0.1 is terminal-only (`scan`, `report`, `findings`). The web app starts only once the
analysis is genuinely useful; it will be a view over the same modules and JSON output.
Supersedes the M4 web milestone in the earlier plan.

## D15 — Everything is a module (2026-10-23)

A plugin bundles modules: adapters (data in), detectors (findings), fixes (patches), later reporters.
Built-in features are plugins too, registered through the same `Registry` as third-party ones
(`--plugin <path|package>`). Nothing in the CLI hard-codes a detector or an adapter.

## D16 — Scope: end-to-end analytics for any AI product, not only coding agents (2026-10-23)

Context: the user wants to embed AgentPrism into their own AI products and have it track and optimize them.
Decision: the core schema is already agent-agnostic (session → turn → model call → tool call).
Own products plug in through a new adapter: a tiny SDK (`@agentprism/sdk`) that wraps LLM client calls and
writes events in AgentPrism's own JSONL format, plus an OTel GenAI span importer. Same store, same detectors.
Sequenced after the coding-agent detectors prove useful (ROADMAP v0.2).

## D17 — Costs computed in SQL via a registered function (2026-10-23)

`ap_cost(model, input, output, cache_read, write_5m, write_1h)` is registered on the connection from the
price table, so every query can aggregate money directly. Requires Node >= 22.13 (`DatabaseSync.function`);
minimum Node version raised from 22.5.

## D18 — Price table (2026-10-23)

First-party Anthropic prices as of 2026-10-06 (from the bundled claude-api reference). Where a cache-read
price is not published per model, use the standard 0.1× input; cache writes 1.25× (5m) and 2× (1h).
Haiku 5.5 has a long-prompt tier (> 100K prompt tokens). Users can override with `~/.agentprism/prices.json`.

## D19 — Positioning: control plane for LLM and agent systems (2026-10-23)

Context: the user's target roles are built around multi-agent systems, evals and token-cost optimization.
Decision: AgentPrism covers the full loop measure → simulate → optimize → guard → prove, for coding agents
(log adapters) and for the user's own products and agent systems (SDK). Each capability is a module
(VISION.md table). Order follows data dependencies: SDK tracing first, then simulation, evals, runtime modules.
Supersedes the coding-agent-only one-liner of D1/D8.

## D20 — The SDK is a second published package with zero dependencies (2026-10-23)

It wraps the user's existing provider client structurally (no import of `@anthropic-ai/sdk`), so it works
with any SDK version and adds nothing to the app's dependency tree. Non-streaming calls keep the original
`APIPromise` (side-effect only); `stream: true` and `messages.stream()` are observed without consuming
the stream for the caller. Traces go to `~/.agentprism/traces/<app>/<YYYY-MM-DD>.jsonl`.

## D21 — Prompt text is not captured by default (2026-10-23)

`capture: "hashes"` (default) stores sizes and hashes of system prompt, prefix and messages — enough for
cost, caching and duplicate analysis. `capture: "text"` stores the text, needed for evals and semantic
cache simulation; it is an explicit opt-in per app.

## D22 — Middleware-served answers cost zero (2026-10-23)

A response returned by a `before` module (cache) is traced with zero usage and a fresh call id.
Why: otherwise every cache hit would be counted as spend again, and the store would drop it as a duplicate
of the original message id. Found by test while building the SDK.

## D23 — With modules, the call is recorded after the `after` chain (2026-10-23)

Without modules the SDK returns the provider's own promise untouched (APIPromise helpers keep working) and
traces as a side effect. With modules it awaits the call, runs `after` modules, then records, so notes from
guards land on the trace. Streams are observed only; `after` modules never rewrite a stream.
