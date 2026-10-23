# Roadmap

Long-term direction. The checkbox-level plan is in `PLAN.md`. Every item is a module (D15): it can ship,
be replaced or be turned off on its own. Order follows data dependencies: nothing can be optimized or
guarded before it is measured.

## v0.1 — Measure: coding agents (done in the terminal)

- Claude Code adapter; spend by project / model / day / session / prompt; cache savings.
- 8 waste detectors with evidence and suggestions; `mark` + `compare`.

## v0.2 — Measure: your own products and agent systems

- `@agentprism/sdk`: wrap an Anthropic (later OpenAI, others) client in one line; every call is traced
  locally in the AgentPrism trace format (JSONL). Prompt text only with opt-in.
- Runtime middleware pipeline in the SDK: the slot where router, cache and guards plug in later.
- Agent-system tracing: sessions, agents, steps, tool calls, parent/child agents.
- Trace adapter: SDK traces land in the same store, same reports, same detectors.
- OpenTelemetry GenAI span importer for apps that are already instrumented.
- Agent analytics: cost and calls per agent, per step, per route; fan-out and loop detection across agents.

## v0.3 — Simulate (what-if on real traffic)

- Routing what-if: which calls a cheaper model could take (by size, task tag, past eval scores), saving vs risk.
- Semantic cache what-if: near-duplicate prompts in real traffic → expected hit rate and savings.
- Prompt-cache what-if: unstable prefixes that break provider caching; savings from fixing them.
- Context what-if: savings from trimming history / tool outputs at different limits.

## v0.4 — Guard (quality)

- Evals module: datasets from real traces, graders (exact, regex, JSON schema, LLM judge), regression runs,
  model/prompt comparison with cost per passing answer.
- Groundedness / hallucination checks: answer vs provided context and sources, citation verification,
  judge model; online sampling in production with flags.
- Quality gates in `compare`: a cost change only counts as a win if quality held.

## v0.5 — Optimize (runtime modules in the SDK)

- Router: rules + learned thresholds from evals; cheap model first, escalate on low confidence or failed checks.
- Semantic cache: embeddings-based lookup with similarity threshold, TTL and per-route opt-in.
- Context trimming: history and tool-output limits, summarization hooks.
- Budgets and alerts: per app / agent / user, hard and soft limits.

## v0.6 — Coding agents, wider

- Adapters: Codex CLI, Gemini CLI, Cursor, OpenCode.
- Fix modules: reviewable patches for CLAUDE.md and permissions.
- Live mode and limit forecasting for subscriptions.

## v1.0 — Platform

- Stable plugin API with docs and a community registry.
- OTLP export to Grafana, Langfuse, Datadog.
- Optional self-hosted team server: many machines, many apps, privacy controls.
- Web app as one more view over the same modules and JSON.

## Launch plan

See `LAUNCH.md`. The headline must be a measured before/after on real traffic.
