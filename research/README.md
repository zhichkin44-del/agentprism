# Research scripts

They read local Claude Code logs (`~/.claude/projects`, or `AGENTPRISM_LOGS`) and print aggregates only;
no message text leaves the machine. Methods and results: [docs/RESEARCH.md](../docs/RESEARCH.md).

| Script                                      | Question                                                      |
| ------------------------------------------- | ------------------------------------------------------------- |
| `r0-spend.mjs`                              | cost split; our prices vs Claude Code's own cost records      |
| `r1-calibrate.mjs`, `r1-dead-context.mjs`   | how much prompt cost carries blocks after their last use (R1) |
| `r2-compaction.mjs`                         | exact compaction optimum vs online rules (R2)                 |
| `q1-forgetting.mjs`, `q1-review-sample.mjs` | owner corrections around compactions; local labeling sheet    |
| `r4-survival.mjs`                           | do log signals predict whether code survives in git (R4)      |
| `r3-placebo.mts`, `r3-adjusted.mts`         | can a before/after be trusted: placebo study (R3)             |

## Reproduce the published numbers

The logs keep growing, so every run uses a cutoff. To rebuild the snapshot
`results/2026-11-04T0820Z.txt`:

```bash
export AGENTPRISM_UNTIL=2026-11-04T08:20:00Z
node research/r0-spend.mjs
node research/r1-calibrate.mjs
node research/r1-dead-context.mjs
node research/r2-compaction.mjs
node research/q1-forgetting.mjs
node research/r4-survival.mjs
npm run dev -- scan --db /tmp/ap.db
npx tsx research/r3-placebo.mts /tmp/ap.db
npx tsx research/r3-adjusted.mts /tmp/ap.db
```

R4's durability test compares edits with today's git HEAD, and r0's price check reads Claude Code's
`cost-state` records, which carry no per-call time. Both move even with the cutoff.
`q1-forgetting.mjs` writes the owner-pair dataset to `.agentprism/research/`, which is local and
gitignored.
