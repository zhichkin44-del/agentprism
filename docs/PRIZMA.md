# Prizma — research program v2 (2026-11-10)

Formerly AgentPrism. Goal: a research project on **how AI models use their context and how they can improve themselves**, with a tool that shows it and advises. v1 is done and stays the base: `docs/RESEARCH.md` (R1–R4, Q1), `docs/FINDINGS.md`, `docs/COMPETITORS.md`.

## Ground rule
Everything is checked against real sources. A claim "nobody has this" is written **only with proof of search**: where we looked, which queries, what we found, the date. Otherwise: "X has it; we do it differently/better like this". Numbers only when measured, with the method.

## Stage 0 — what already exists (before any new experiment)
| Step | Work | Gate — done when |
|---|---|---|
| 0.1 | Review: papers (arXiv, ACL/NeurIPS/ICLR), Anthropic / Google / OpenAI guides on context, observability tools (Langfuse, LangSmith, Helicone, Arize Phoenix, AgentOps, …); extend `docs/COMPETITORS.md` | `docs/prior-art.md`: table "who · what · link · date", ≥ 40 sources, each opened and read |
| 0.2 | Gap map: what nobody has | each gap lists the places searched, the queries and the date; "not found" ≠ "does not exist" — say so |
| 0.3 | Ready methods to reuse: context compaction and summarization, prompt caching, memory, RAG, subagents, skills with progressive disclosure, LLM-as-judge, reflection, rules learned from mistakes | `docs/methods.md`: method · source · how we apply it · how we measure it |
| 0.4 | Uniqueness statement | 3–5 claims "Prizma is first in …", each confirmed independently by Claude and Gemini (two branches, reconciled in a PR) |

## Research questions (after stage 0; order may change after 0.2)
| # | Question | How |
|---|---|---|
| Q-A | What the model actually uses from its context and what it ignores (middle of long contexts) | controlled experiments with markers at different positions |
| Q-B | Why agents re-read the same content and what it costs (v1: ~85% of cost is re-sent context) | Claude Code and Gemini logs, chunk labelling |
| Q-C | When to compact and what is lost (v1: rule within 4–16% of the optimum) | replicate on new data and another model |
| Q-D | Memory, skills, subagents, cache — what really saves without hurting quality | A/B on identical tasks |
| Q-E | Self-improvement: reflection, LLM-as-judge, rules from mistakes — is there a gain | before/after on a fixed task set |
| Q-F | Claude vs Gemini: different use of context | same tasks on both models |

## Roles
| Who | Where | What |
|---|---|---|
| Claude (second Pro account; Sonnet, Opus for review) | dev-machine | experiments, tool code, reports |
| Gemini (Antigravity) | dev-machine | literature review, cross-checking Claude's claims |
| Review (Claude Opus, Pulse AI director) | zhichkin44-del | PR review: sources open, numbers reproduce |
| Owner | — | decisions, merges, publishing |

## Rules
- Each agent works on its own branch (`claude/…`, `gemini/…`) → PR. Never push to `main`.
- Agent logs are analysed **only locally on their own machine**; git gets anonymized aggregates only. Logs may contain keys and private data.
- Every experiment is reproducible: script + input data (or its description) + the command to run.
- Anything public (paper, site, npm) only with the owner's "yes".
