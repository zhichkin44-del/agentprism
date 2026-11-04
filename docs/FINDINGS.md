# What we found: the economics of an AI agent's context

_November 2026. Data: 12 days of real work by one studio of AI coding agents on one machine: Claude Code
logs plus git history. Everything was computed locally; no message ever left the machine. Details, methods
and caveats are in [RESEARCH.md](RESEARCH.md); the scripts are in [`research/`](../research)._

## What we found

1. **Most of the money is re-reading the past.** On every step an agent sends the whole conversation to the
   model again. In the main chain that is about 85% of the cost; the model's answers are the smaller part.
   The accounting is exact: it matches Claude Code's own cost records to the cent. That check also caught
   a wrong price in our table.

2. **A real part of what is re-read is no longer needed.** We priced every block of context (a command's
   output, a file that was read, an answer). For each one we know what it cost to carry and whether
   anything used it later. As an upper bound, about a fifth of the prompt cost carries blocks after their
   last use, most of all command output. The test for "used" finds nearly all of several hundred known
   uses. Use by meaning, with no shared identifier, stays invisible.

3. **The model's thinking stays in the context.** Every later call re-reads it. That is a noticeable share
   of the bill, and the logs cannot show whether it helps: the thinking text is hidden.

4. **When to compact has a robust answer.** We computed the exact optimum in hindsight: the best moments to
   compact, knowing the whole session. One simple rule comes close to it under every assumption about the
   price of forgetting: compact when the excess re-reading reaches the cost of one compaction. A fixed
   threshold ("compact at 200K tokens") is good for one assumption and several times worse for others.

5. **The key unknown is the price of forgetting.** A long context pays off only if compaction breaks
   something.
   - In tokens we could not tell that price from zero: after a compaction the agent barely re-reads anything.
   - There is a weak sign, not statistically significant, that the owner corrects the agent more often right
     after a compaction ("you forgot").
   - The real price is the owner's attention, not money.

6. **A negative result.** Signals in the logs do not predict whether an agent's code survives in git. That
   covers owner corrections, failed commands and undone edits. In this studio code dies mostly because the
   product moves on, not because it was a mistake. We dropped that hypothesis.

## The technology nobody has

**Context economics for AI agents.** It knows the cost and the value of every piece of context, and decides
what to keep, what to move to memory and when to compact. The decision rule is close to the exact optimum
and prices in the cost of forgetting.

- Today's tools count what was spent and where: ccusage, Claude Code's own `/usage`, cctx and others. None
  of them prices the value of each piece of context. None of them decides when to compact with cache
  prices in mind.
- 2025–2026 research optimizes compaction for token counts. One study shows that in Claude Code cutting
  tokens can raise the bill, because of the cache. We found no cache-priced rule for when to compact.

**A second candidate: switchback tests for a coding-agent workflow.** Before/after on one person's logs
does not work. On 12 days with no change at all, the naive comparison reported changes of an order of
magnitude, because the work drifts. Switching the change on and off on random days cancels the drift.
AgentPrism plans such a schedule (`agentprism switchback`) and analyses it from the logs with an adjusted
estimator. The design itself is standard in marketplace experiments. Applying it to coding-agent
workflows, measured from the agent's own logs, we have not found anywhere.

- _How we checked._ Web searches on 2026-11-04 for switchback experiments with coding agents, Claude Code
  or AI agents, plus a 2025–2026 literature sweep on 2026-11-04 for causal before/after methods on
  agent logs (CUPED, difference-in-differences, synthetic control).
- _What we did find._ A general tutorial on switchback designs for LLM-platform features, on synthetic
  data ([freeCodeCamp](https://www.freecodecamp.org/news/switchback-experiments-for-ai-platform-features-in-python)).
  General switchback overviews ([Statsig](https://www.statsig.com/blog/switchback-experiments)).
  Research on the design itself ([arXiv 2506.12654](https://arxiv.org/abs/2506.12654)).
- _Caveat._ "Not found" is not proof.
- _Known weakness._ Carry-over: a session that runs into the next day keeps the old setting.

## Evidence

- The cost accounting is checked against Claude Code's own records.
- The size of each block is reconstructed from the measured growth of the prompt, which the fit explains
  at 97%.
- The test for "used" is validated on cases where use is certain: an edit proves that the agent had read
  the text it changed.
- The exact optimum is computed, and the rule is compared with it on every session.
- Negative results are written down the same way as positive ones.

**Not yet:**

- replaying requests to the model without a block, which would send logs to an API;
- human-verified labels of the owner's corrections;
- data from other machines and other people.

## What exists now

`agentprism context` runs on any Claude Code session, live or past. It shows:

- what in the context is expensive and no longer used;
- what that costs;
- when the rule would compact, for a chosen price of forgetting.

It writes an anonymized HTML report: no messages, no paths, no titles. It is advisory and changes nothing.

## What next

1. **Measure the price of forgetting.** Use human-labelled corrections, more compactions, and replay if the
   owner allows it.
2. **Couple it with memory.** Before compacting, keep what is still used. Compaction then gets cheaper, and a
   long context is no longer necessary.
3. **Placebo-check before/after comparisons.** Any future "it got better" must survive the question "is it
   just chance?".
