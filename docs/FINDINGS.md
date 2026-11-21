# What we found: the economics of an AI agent's context

_Data: 12 days of real work by one multi-agent setup of AI coding agents on one machine (Claude Code logs plus git
history), up to 2026-11-04 08:20 UTC. All dollar figures are API-equivalent at Anthropic list prices, not a
bill. Everything was computed locally; no message left the machine. Numbers come from the snapshot
[`research/results/2026-11-04T0820Z.txt`](../research/results/2026-11-04T0820Z.txt). Methods and caveats
are in [RESEARCH.md](RESEARCH.md). AI agents did the research in one day, 2026-11-04._

## What we found

1. **Most of the cost is sending the past again.** On every step an agent re-sends the whole conversation.
   - In the main chain that is about 85% of the cost: cache reads ≈65%, cache writes ≈20%.
   - The model's answers are the rest.
   - For every model, Claude Code's own cost for the same tokens falls inside our price bounds. The
     bounds are a range because the logs do not say whether a cache write was billed at the 5-minute or
     1-hour rate. That check also caught a wrong price in our table.

2. **A part of what is re-sent is no longer used.** We priced every block of context (a command's output, a
   file that was read, an answer) on every call that carried it.
   - By a liberal rule, about a fifth of the prompt cost (21%) carries blocks after their last use, most
     of all command output.
   - That rule is "a later output reuses one of the block's rare identifiers, or works on its file".
   - It finds 98% of 212 uses known for certain. That check is nearly built in: the known uses (an edit's
     text found in an earlier read) are themselves identifier matches. Its precision is not measured.
   - Use by meaning, with no shared identifier, is invisible.
   - The 21% is therefore an upper bound for this rule, not a saving anyone can bank.

3. **The model's thinking stays in the context.** Every later call re-reads it: about 11% of the prompt
   cost. The logs cannot show whether it helps, because the thinking text is hidden.

4. **A simple compaction rule tracks the exact optimum, if the price of forgetting is known.**
   - We computed the exact optimum in hindsight: the best moments to compact, knowing the whole session.
   - The rule: compact when the excess re-reading reaches the cost of one compaction (by analogy with
     ski-rental, no formal proof).
   - In simulation on these 12 days of one user, at five assumed prices of forgetting ($0–20 per
     compaction), it stayed within 4–16% of that optimum.
   - If the rule assumes forgetting is free when it is not, it loses up to 2.5×.
   - A fixed threshold ("compact at 200K tokens") is good at one price and up to 3× worse at others.

5. **The price of forgetting is the key unknown.** A long context pays off only if compaction breaks
   something.
   - In our logs the agent barely re-reads files after a compaction, and the extra corrections by the owner
     are not statistically significant on 28 compaction points.
   - On a larger history (one user, 873 compactions), [LangWatch] found 2.37× more user corrections right
     after a compaction. Our small sample cannot rule out an effect that large.
   - The real price is probably the owner's attention rather than tokens.

6. **Nothing detected for code survival, with little power.** Signals in the logs did not predict whether
   an agent's code survives in git. Those signals were owner corrections, failed commands and undone edits.
   Several of them were almost absent: 0 interrupts, 1 undo, 15 strict corrections, 18–22 sessions. That
   is a failure to detect, not proof of no effect. That code mostly dies because the product moves on is
   our hypothesis; it was not measured.

## What is new, narrowly

Counting tokens and cost is solved (ccusage, Claude Code's `/usage`, cctx). Measuring what compaction costs
has been started too: [LangWatch] measured rework and user corrections after 873 compactions and chose a
threshold from a token-count model. What we did not find elsewhere:

- **A price for every block of context, with cache prices.** Every block is priced on every call that
  carries it, and its use is tracked. That gives the share of the bill spent after last use.
- **An online compaction rule checked against the exact optimum.** The optimum is computed per session,
  and the rule's gap to it is measured across prices of forgetting. A fixed threshold from an offline
  sweep is a different thing.
- **Switchback tests for a coding-agent workflow.**
  - Before/after on one person's logs does not work: on 12 days with no change at all, the naive
    comparison reported changes of an order of magnitude, because the work drifts.
  - Switching the change on and off on random days cancels the drift. AgentPrism plans such a schedule
    (`agentprism switchback`) and analyses it from the logs with an adjusted estimator.
  - The design is standard in marketplace experiments.

How we checked:

- _Searches._ Web searches on 2026-11-04 for switchback experiments with coding agents, Claude Code or AI
  agents. A 2025–2026 literature sweep the same day on context compaction, caching and causal
  before/after methods.
- _What we found instead._ A general tutorial on switchback designs for LLM-platform features, on
  synthetic data ([freeCodeCamp](https://www.freecodecamp.org/news/switchback-experiments-for-ai-platform-features-in-python)),
  a general overview ([Statsig](https://www.statsig.com/blog/switchback-experiments)) and research on the
  design itself ([arXiv 2506.12654](https://arxiv.org/abs/2506.12654)).
- _Caveat._ "Not found" is not proof.
- _Known weakness of switchback here._ Carry-over: a session that runs into the next day keeps the old
  setting.

## Evidence

- **Cost.** For every model, Claude Code's own records for the same tokens fall inside our price bounds
  (write TTL unknown). See `r0-spend` in the snapshot.
- **Block sizes.** Each block's size comes from the measured growth of the prompt; the fit explains 97% of
  that growth.
- **"Used".** The rule is checked for recall on cases where use is certain. Its precision is still to be
  checked by hand.
- **The rule.** The exact optimum is computed, and the rule is compared with it on every session at five
  prices of forgetting.
- **Before/after.** It was tested with placebo marks. The naive method failed, and the adjusted one is
  close to the expected false-alarm rate.
- **Negative results.** They are written down the same way as positive ones.

**Not yet:**

- the precision of the "used" rule (needs 50–100 hand-labelled cases);
- human-verified labels of the owner's corrections;
- replaying requests to the model without a block, which would send logs to an API;
- data from other machines and other people.

## What exists now

`agentprism context` runs on any Claude Code session, live (`--watch`) or past. It shows:

- what in the context is expensive and no longer used;
- what that costs;
- when the rule would compact, for a chosen price of forgetting.

It writes an anonymized HTML report: no messages, no paths, no titles. It is advisory and changes nothing.
`agentprism compare` gives an adjusted before/after with an interval and an honest verdict, and
`agentprism switchback` plans a test that survives drift.

## What next

1. **Measure the price of forgetting.** Use human-labelled corrections, more compactions, and replay if
   the owner allows it.
2. **Couple it with memory.** Before compacting, keep what is still used. Compaction then gets cheaper,
   and a long context is no longer necessary.
3. **Prove one change with a real switchback.** Two weeks of ON/OFF days, when the owner chooses a change
   to test.

[LangWatch]: https://langwatch.ai/blog/context-tax-when-to-compact
