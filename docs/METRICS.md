# Metrics

The point of the project: show measured improvement on real work. Definitions first, then numbers.

## Definitions

| Metric           | Definition                                                                                                        |
| ---------------- | ----------------------------------------------------------------------------------------------------------------- |
| Spend (API-eq.)  | Σ over de-duplicated model calls of tokens × list price (`packages/core/src/pricing`), cache writes priced by TTL |
| Cost parts       | the same, split into input / output / cache read / cache write, all at the tier of the whole prompt               |
| Caching saved    | cost if every cached token had been billed as fresh input, minus actual cost                                      |
| Context per call | input + cache read + cache write tokens of one call (the prompt size)                                             |
| Peak context     | max context per call within a session                                                                             |
| Tool error rate  | errored tool results (not denials) / all tool results                                                             |
| Estimated waste  | Σ of detector findings, capped per session at that session's cost (detectors can overlap)                         |
| Waste share      | estimated waste / spend                                                                                           |

### How each detector estimates waste

| Detector            | Counted as avoidable                                                                                                       |
| ------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| Context growth      | cache reads of context beyond 100K, on calls whose context exceeds 200K (main chain)                                       |
| Cache rebuilds      | cache writes ≥ 100K tokens, minus the 50K a fresh summarized session would write                                           |
| Oversized outputs   | (result tokens − 500) × cache-read price of every later call that carried it, until compaction; ≤ session cache-read spend |
| Loops               | full cost of the model calls that issued the 2nd+ identical tool call in a turn whose result also did not change           |
| Failing tools       | full cost of the calls behind repeated identical failures, or behind all errors in error-heavy sessions                    |
| Repeated reads      | re-read content × cache-write price                                                                                        |
| Rediscovered files  | first-read content × (sessions − 1) × cache-write price                                                                    |
| Permission friction | full cost of the calls that asked again for an identical, already denied tool call                                         |
| Uncached prompts    | (n − 1) × smallest prompt in the group × (input − cache-read price), minus one cache-write premium (SDK traces only)       |
| Unstable prefix     | cache-write tokens of calls whose prefix changed from the previous call × (write − read price) (SDK traces only)           |
| Duplicate requests  | average cost × repeats of byte-identical requests (what an exact-match cache saves) (SDK traces only)                      |

Token sizes of tool results are estimated at ~4 characters per token, images at ~1,600 tokens each.
All waste figures are **upper-bound estimates** meant for ranking and for before/after comparison,
not exact savings.

## Method (to keep the comparison honest)

- `agentprism mark "<what changed>"` at the moment of a change; `agentprism compare` afterwards.
- Sessions are assigned to a period by **start time**; a long session that straddles the mark counts as
  "before" (to be improved: split by call time).
- Compare per-session medians, not totals (session counts differ).
- Note confounders: model changes, kinds of tasks, Claude Code version updates.

## Baseline (2026-10-23, all sessions 2026-09-27 → 2026-10-23)

Data: 34 log files, 31 sessions, 6 projects, 968 prompts, ~6,600 model calls, all `claude-opus-5-5`.

| Metric                      | Value                                                        |
| --------------------------- | ------------------------------------------------------------ |
| Spend (API-equivalent)      | **$836** (cache reads 63%, cache writes 24%, output 12%)     |
| Caching saved               | $9,954 (92% of what it would cost uncached)                  |
| Per prompt / per model call | $0.86 / $0.13                                                |
| Most expensive session      | $391 — 528 prompts, peak context 942K, 20 compactions        |
| Estimated waste             | **≈ $502 (60%)**                                             |
| — context growth            | $393 across 7 sessions                                       |
| — cache rebuilds            | $101 across 5 sessions (most after breaks > 1 hour)          |
| — oversized outputs         | $4.08                                                        |
| — permission friction       | $2.98                                                        |
| — loops                     | $0.67                                                        |
| — repeated reads            | $0.32 (Claude Code already de-duplicates unchanged re-reads) |
| Tool error rate             | 2.3% (no identical failure was retried)                      |

**What it says:** the money is not lost in tools or loops — it is lost in **session length**. Very long
sessions re-read up to ~1M tokens of history on every call, and resuming them after a break rewrites the
whole context to the cache. The behavioral fix to test first: one task per session, and a fresh session
(from HANDOFF/CLAUDE.md) after any long break.

## Snapshot 2 (2026-11-04, second machine, sessions 2026-10-23 → 2026-11-04)

Not comparable with the baseline above: different machine, period and mix of work (an orchestrator session
that steers many agent sessions). Data: 131 log files (463 MB), 9,790 model calls; Opus 5.5 / Sonnet 5.5 / Haiku 5.5.

| Metric                                 | Value                                                                        |
| -------------------------------------- | ---------------------------------------------------------------------------- |
| Spend (API-equivalent), current table  | $916 — an independent script reproduces it to $0.50                          |
| Spend with Sonnet 5.5 cache read fixed | **$851** (table has $0.20/M; Claude Code's own `cost-state` implies $0.10/M) |
| Cache reads share of tokens            | 98.7%                                                                        |
| Top 3 long-lived sessions              | ~91% of spend                                                                |
| Estimated waste (detectors)            | $481 (52%) — context growth $409, cache rebuilds $55, oversized outputs $11  |
| Fixed prefix per call                  | ~41K tokens (system 7K, built-in tools 22K, MCP 11K) ≈ $73 of cache reads    |
| Tool error rate                        | 2.6% (307 / 12,025), 75 denials                                              |
| First scan / re-scan                   | 1.8 s / 0.1 s inside the CLI                                                 |

After the honesty fixes (D24–D26), re-run later the same day on 134 files: spend **$869**, and the price check
passes for Opus, Sonnet and Haiku 5.5. Estimated waste is $440 (51%). Loops fell from $2.92 to $0.92
(3 findings instead of 16), and permission friction from $3.27 to $0. The headline share is still driven by
the context-growth upper bound ($374); see `RESEARCH.md`.

**What-if prototype (auto-compact threshold, main chain, corrected prices).** Replays every call with the
history beyond the threshold removed; after a compaction the context restarts at 96K (median of 16 real
compactions in these logs); each simulated compaction costs one summarizing call.

| Threshold | Simulated spend | Saved      | Extra compactions |
| --------- | --------------- | ---------- | ----------------- |
| actual    | $806            | —          | —                 |
| 400K      | $600            | $206 (24%) | 22                |
| 300K      | $547            | $259 (30%) | 38                |
| 200K      | $525            | $280 (33%) | 93                |
| 150K      | $573            | $232 (27%) | 195               |

**What it says:** the context-growth detector ($409) overstates what a real setting could save; the best
single setting recovers ~$260–280. Not modelled yet: files re-read after a compaction, quality loss.

## After

_To be filled in after the fix has been applied and a working period has passed (M4)._
