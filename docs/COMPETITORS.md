# Competitors

Checked 2026-11-04 (pages opened, stars and last push from the GitHub API). Re-check before launch.

## Coding-agent usage and waste

| Tool                         | Stars, last push | Does                                                                                                                                                                                         | Does not                                                                                                          |
| ---------------------------- | ---------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| [ccusage]                    | 19.3k, 2026-11   | cost by day / session / 5h block for Claude Code, Codex, Gemini CLI and others; statusline; JSON                                                                                             | no waste, advice, before/after or what-if                                                                         |
| [Claude-Code-Usage-Monitor]  | 8.8k, 2026-07    | live TUI, burn rate, plan-limit forecast                                                                                                                                                     | no waste or advice                                                                                                |
| [cctx]                       | 9, 2026-09       | `autopsy`: 10 waste patterns with $; `harvest`: CLAUDE.md patches; `--efficacy`: finding rates per patch                                                                                     | no what-if simulation, no savings forecast, no forecast-vs-actual                                                 |
| Claude Code [`/usage`][cost] | built in         | cache-miss stats with likely cause; usage shares by skill / subagent / plugin / MCP; recommendations, `f` applies them                                                                       | shares are "not how much the change saves"; no $ savings, no before/after                                         |
| Claude Code `/insights`      | built in         | LLM-written HTML report on friction                                                                                                                                                          | qualitative, spends plan usage                                                                                    |
| Claude Code [OTel][otel]     | built in         | raw cost and token metrics, events                                                                                                                                                           | no analysis                                                                                                       |
| [LangWatch] blog (study)     | 2026-08-02       | one user, 873 compactions: rework after compaction (~28 steps), user corrections after it (2.37×), LLM-judged used context per step, cost-optimal threshold from a token-count model (≈220K) | not a tool; fixed threshold from an offline sweep; no per-block cache prices; no comparison with an exact optimum |
| Small analyzers              | 0–82             | agent-waste-audit, claude-crusts, claude-token-analyzer, ccwhy: duplicate reads, unused MCP, cache rewrites                                                                                  | mostly tokens only; no what-if, no forecast check                                                                 |

## LLM observability

Langfuse (37k), Opik (23k), Phoenix (12k), OpenLLMetry (7.5k), Helicone (6.3k), Laminar (5.9k), LangSmith,
Weave, AgentOps: SDK / proxy / OTel tracing with per-trace cost. None reads coding-agent logs or looks for
agent waste. AgentPrism's SDK has no edge here.

## What we did not find elsewhere (as of 2026-11-04; "not found" is not proof)

1. **A price for every block of context, with cache prices.** It is tracked call by call, with the share
   of the bill spent after a block's last use.
2. **An online compaction rule checked against the exact optimum** per session, across prices of
   forgetting. LangWatch chose a fixed threshold from an offline sweep over a token-count model.
3. **Switchback tests of a coding-agent workflow**, analysed from the agent's own logs.

A threshold what-if on past logs is not new. LangWatch's blog shows the same kind of curve, which is why
the earlier "what-if" idea was dropped.

[ccusage]: https://github.com/ryoppippi/ccusage
[Claude-Code-Usage-Monitor]: https://github.com/Maciek-roboblog/Claude-Code-Usage-Monitor
[cctx]: https://github.com/jacquardlabs/cctx
[cost]: https://code.claude.com/docs/en/costs
[otel]: https://code.claude.com/docs/en/monitoring-usage
[LangWatch]: https://langwatch.ai/blog/context-tax-when-to-compact
