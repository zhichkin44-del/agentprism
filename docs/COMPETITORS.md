# Competitors

Checked 2026-11-04 (pages opened, stars and last push from the GitHub API). Re-check before launch.

## Coding-agent usage and waste

| Tool                         | Stars, last push | Does                                                                                                                   | Does not                                                                  |
| ---------------------------- | ---------------- | ---------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------- |
| [ccusage]                    | 19.3k, 2026-11   | cost by day / session / 5h block for Claude Code, Codex, Gemini CLI and others; statusline; JSON                       | no waste, advice, before/after or what-if                                 |
| [Claude-Code-Usage-Monitor]  | 8.8k, 2026-07    | live TUI, burn rate, plan-limit forecast                                                                               | no waste or advice                                                        |
| [cctx]                       | 9, 2026-09       | `autopsy`: 10 waste patterns with $; `harvest`: CLAUDE.md patches; `--efficacy`: finding rates per patch               | no what-if simulation, no savings forecast, no forecast-vs-actual         |
| Claude Code [`/usage`][cost] | built in         | cache-miss stats with likely cause; usage shares by skill / subagent / plugin / MCP; recommendations, `f` applies them | shares are "not how much the change saves"; no $ savings, no before/after |
| Claude Code `/insights`      | built in         | LLM-written HTML report on friction                                                                                    | qualitative, spends plan usage                                            |
| Claude Code [OTel][otel]     | built in         | raw cost and token metrics, events                                                                                     | no analysis                                                               |
| Small analyzers              | 0–82             | agent-waste-audit, claude-crusts, claude-token-analyzer, ccwhy: duplicate reads, unused MCP, cache rewrites            | mostly tokens only; no what-if, no forecast check                         |

## LLM observability

Langfuse (37k), Opik (23k), Phoenix (12k), OpenLLMetry (7.5k), Helicone (6.3k), Laminar (5.9k), LangSmith,
Weave, AgentOps: SDK / proxy / OTel tracing with per-trace cost. None reads coding-agent logs or looks for
agent waste. AgentPrism's SDK has no edge here.

## Where AgentPrism can be the only one

1. **What-if on your own logs, in dollars:** replay the past month with another auto-compact threshold,
   `/clear` after breaks, another subagent model, fewer MCP servers. Nobody checked offers it.
2. **Forecast → apply → verify:** apply the chosen setting, record the forecast, then show forecast vs actual.

[ccusage]: https://github.com/ryoppippi/ccusage
[Claude-Code-Usage-Monitor]: https://github.com/Maciek-roboblog/Claude-Code-Usage-Monitor
[cctx]: https://github.com/jacquardlabs/cctx
[cost]: https://code.claude.com/docs/en/costs
[otel]: https://code.claude.com/docs/en/monitoring-usage
