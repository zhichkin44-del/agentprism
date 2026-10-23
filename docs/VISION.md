# Vision

## One line

**AgentPrism is the local-first control plane for LLM and agent systems**: it measures what your
models and agents do and what it costs, optimizes it (routing, caching, context), guards quality
(evals, hallucination checks), and proves every change with before/after numbers.

## The loop

```
 measure  →  simulate  →  optimize  →  guard  →  prove
 traces,     "what if"     router,       evals,     before/after
 spend,      on your own   semantic      grounded-  on the same
 waste       logs          cache, trim   ness       metrics
```

Every step is a module. Every module reads and writes the same normalized data.

## The problem

Teams now ship products built from LLM calls and multi-agent systems, and steer coding agents all day.
The work is a black box:

- the bill or the rate limit arrives and nobody knows which feature, agent or prompt caused it;
- agents loop, retry, drag huge context and outputs from call to call;
- the expensive model answers questions a cheap one would handle; identical questions are paid again;
- quality is a feeling: nobody knows whether a new prompt, model or route made answers better or worse,
  or how often the system makes things up;
- every optimization is a guess, because there is no before/after on real traffic.

## Positioning

Existing tools each cover one slice: usage counters (ccusage, …), tracing (Langfuse, Helicone),
gateways (LiteLLM, Portkey), evals (promptfoo, Braintrust), guardrails. AgentPrism's edge is the loop:

| Question                                       | AgentPrism                                                            |
| ---------------------------------------------- | --------------------------------------------------------------------- |
| Where does the money go, and **why**?          | spend by app / agent / route / prompt + waste detectors with evidence |
| What would a change save **before** I make it? | simulation on real logs: routing, semantic cache, context limits      |
| How do I apply it?                             | runtime modules in the SDK: router, cache, trimming, guards           |
| Did quality hold?                              | evals on the same traffic: regression sets, LLM judge, groundedness   |
| Did it actually work?                          | `mark` + `compare`: measured before/after                             |

Covered sources: coding agents (Claude Code first) through log adapters; your own products and
agent systems through the SDK and OpenTelemetry GenAI traces.

## Modules (all optional, all replaceable)

| Area     | Module                                                   | Kind               |
| -------- | -------------------------------------------------------- | ------------------ |
| Measure  | adapters (Claude Code, AgentPrism SDK traces, OTel)      | data in            |
| Measure  | spend, agents, waste detectors                           | analysis           |
| Simulate | routing what-if, semantic cache what-if, context what-if | analysis           |
| Optimize | router, semantic cache, context trimming                 | runtime (SDK)      |
| Guard    | evals, LLM judge, groundedness / hallucination checks    | runtime + analysis |
| Prove    | mark / compare, experiments                              | analysis           |
| Views    | terminal, JSON; web app later                            | output             |

## Principles

1. **Value in 30 seconds.** One command or a three-line SDK wrap; no account, no cloud.
2. **Local-first and private.** Data stays on the machine. Prompt text is not stored unless you opt in.
3. **Lightweight.** Pure TypeScript, zero runtime dependencies, no native builds.
4. **Universal.** Provider- and agent-agnostic core; schema aligned with OpenTelemetry GenAI conventions.
5. **Evidence, not vibes.** Every number has a definition; every estimate is capped and labelled.
6. **Modular.** Every feature is a module with a small, stable interface; built-ins load like plugins.
7. **Honest about limits.** Hallucinations can be detected and reduced, not eliminated; we say so.

## Who it is for

- AI engineers building LLM features and multi-agent systems who own cost, latency and quality.
- Developers on coding agents who hit limits or pay per token.
- Later: teams that need visibility and control across many apps and agents.

## What success looks like

- The author's own products and agent work measurably cheaper at equal quality, published in the README.
- Time to first insight under 30 seconds; SDK overhead under 1 ms per call.
- 1,000+ GitHub stars within months of launch — a target, not a promise.
