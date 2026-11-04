# Progress log

Newest entry on top. Each entry: what was done, what was found, what is next.

---

## 2026-11-04 (late) — R4 code survival (negative); research paused for review

**Done**

- `research/r4-survival.mjs` matches 1,566 agent edits against git: the next commit touching the file,
  and the current HEAD for edits older than two days. It scores log signals by AUROC with sessions held
  out.
- A one-page summary of the research in Russian for the owner, kept outside the repo in the session notes.

**Found**

- 91.5% of edits are in the next commit, because agents commit their own work, and 71.3% are still in HEAD
  after two days. No log signal predicts it: owner corrections, failed commands, interrupts and undo all
  sit near AUROC 0.5. Candidate C4 is not supported on this data.

**Next**

- Waiting for the owner: label 60 pairs, and choose between an advisory context-economics prototype and
  R3.

---

## 2026-11-04 (night) — Q1 the price of forgetting by quality; owner-pair dataset

**Done**

- `research/q1-forgetting.mjs` pairs each of 801 owner messages with the agent turn before it and
  classifies corrections (broad and strict variants). It compares rates around 28 compaction points and
  across prompt sizes.
- Reusable local dataset `.agentprism/research/owner-pairs.jsonl` (gitignored) in the format
  `CORRECTIONS_FORMAT.md`. It is also the training data for the planned "owner's voice". A local labeling
  sheet holds 60 sampled pairs.

**Found**

- Corrections may rise slightly after a compaction (strict 0.9% → 3.2%, "you forgot" 0 → 3), but no
  interval excludes zero. In tokens the price of forgetting is ≈ $0.2–0.8 per compaction, far below the
  ~$20 at which a long context pays off. The real cost is the owner's attention: ~15 extra corrections in
  12 days (upper bound ~60) against ~$250 API-equivalent saved.
- The rate of corrections does not grow with prompt size.
- The classifier is unvalidated (broad and strict differ 5×). The owner's labels are needed.

**Next**

- The owner labels the sheet, which gives precision and recall, and gold data for the owner's voice.
- R3 (placebo) and R4 (quality index on git) are still open.

---

## 2026-11-04 (evening) — R1 dead context, R2 when to compact

**Done**

- `research/` scripts that read local logs and print only aggregates. Results are in `RESEARCH.md`.
- R1: a ledger of every block of context.
  - Sizes come from measured prompt growth (fit R² = 0.97), costs from exact per-call prices.
  - Use is inferred from shared rare identifiers, validated on 212 known uses (Edit ← Read, recall 98%).
- R2: replay with an exact DP optimum of compaction points, online rules, and rework measured on the
  real compactions.

**Found**

- 21% of prompt cost ($148 of $707) carries content after its last use. That is an oracle bound, not a
  forecast. Thinking from earlier calls stays in context: 11% of prompt cost, and its use is invisible.
- The ski-rental rule (compact when excess reads reach one compaction's cost) stays within 1.04–1.16× of
  the optimum for any price of forgetting. Fixed thresholds reach 3×.
- The recorded long-context schedule is optimal only if a compaction destroys ≥ ~$20 of work. Rework seen
  as re-fetching is ~0, and quality loss is not measured. The price of forgetting is the missing number.

**Next**

- Measure the price of forgetting (quality, not just re-reads). Combine R1 + R2: a memory that keeps
  still-used blocks lowers that price. R3 (placebo) and R4 (quality index) are still open.

---

## 2026-11-04 (later) — Honest numbers (stage 0) and a research program

**Done**

- Owner's decision: the launch plan is not approved, because a what-if over past logs is not new enough.
  The Studio's own settings stay unchanged. AgentPrism becomes a research project aimed at a new technology.
- Sonnet 5.5 cache read fixed to $0.10/M. It is confirmed by Claude Code's `cost-state` and by Anthropic's
  docs (0.05× input).
- `priceCheck` compares our prices with the agent's own cost records and is shown under Spend (D24). The
  "partial cost" line is gone.
- Loops need the same result, since tool results are now hashed in schema v5 (D25). Denials are friction,
  not waste (D26).
- Two literature sweeps, 2025–2026, with links opened. `RESEARCH.md` holds the open problems, five
  candidates (C1–C5) and the order of work R1–R4.

**Found**

- On real logs: spend $869, and the price check passes for all three models. Loop findings fell from 16
  to 3, and permission waste from $3.27 to $0.
- A blog already shows an offline compaction-threshold curve (optimum 250–450K), so our what-if prototype
  is not new. A 2026 paper shows that in Claude Code cutting tokens can raise the bill. Both point to
  cache-aware control as the open problem.

**Next (waiting for the owner)**

- Choose the research steps: R1 (dead-weight share of the bill) and R2 (offline-optimal context schedule)
  first.

---

## 2026-11-04 — Competitor check, real-log audit, what-if prototype

**Done**

- Competitor map with checked links: `COMPETITORS.md`.
- Ran the CLI on the Studio machine's logs (131 files, 463 MB, 12 days). An independent script
  reproduces the spend to $0.50. New snapshot in `METRICS.md`.
- Prototype auto-compact what-if, outside the repo, that replays every call with a threshold.
- New log facts in `LOG_FORMAT.md`: request records with the full system prompt and tool definitions, and
  `cost-state` as a source for Claude Code's own price table.

**Found**

- Sonnet 5.5 cache-read price in the table is 2× too high ($0.20 vs $0.10/M by Claude Code's own
  accounting). Spend is overstated by 7% ($916 vs $851).
- The context-growth detector ($409) overstates realistic savings. The best compaction threshold recovers
  ~$260–280 (30%), with a U-shaped curve.
- Counting denials as waste is questionable. Repeated identical browser screenshots are flagged as loops.
- Usage counters (ccusage) and waste-to-CLAUDE.md tools (cctx, `/usage` + `f`) already exist. Nobody does
  what-if in dollars or forecast-vs-actual.

**Next:** proposed a launch plan around `whatif`; it was not approved (see the entry above).

---

## 2026-10-23 — Repositioning + M5 SDK

**Done**

- Positioning (D19): control plane for LLM and agent systems — measure → simulate → optimize → guard → prove.
  VISION, ROADMAP, PLAN rewritten; every capability is a module.
- Russian primer for the user (Claude Doc "Конспект: токены, качество и AgentPrism") with a method diagram
  and the waste chart.
- `@agentprism/sdk` (zero deps): `agentprism({ app })`, `instrument(client)` for `messages.create`
  (plain + `stream: true`) and `messages.stream()`, `withSession` / `withTurn` / `withAgent`, `tool()`,
  middleware pipeline (`before` / `after`), capture hashes by default (D20–D23).
- Trace format v1 (`TRACE_FORMAT.md`) + `adapter-traces`; store schema v4 (agent, prefix/prompt hashes, latency).
- Product detectors: uncached prompts, unstable prompt prefix, duplicate requests. `report` shows apps and agents.
- 47 tests incl. an end-to-end app → traces → findings test.

**Found**

- Two bugs caught by the new tests: SQL `agent` was ambiguous (sessions also has an `agent` column); `after`
  modules ran after the trace was written, so guard notes were lost. Both fixed.
- A cached answer must be traced with zero usage and a new id, or savings would count as spend (D22).

**Next**

- Instrument one of the user's real products with the SDK to get real app traces.
- M6 simulations: routing what-if, semantic-cache what-if (needs `capture: "text"` or `lastUserHash`).
- OpenAI client support; OTel importer; SDK build for npm.

---

## 2026-10-23 — M2 Money, M3 Detectors, M4 compare

**Done**

- Direction from the user: terminal first, web app later (D14); everything is a module (D15);
  scope widened to end-to-end analytics for the user's own AI products (D16, planned as M6 / v0.2).
- Module system: `Plugin`, `Registry`, `--plugin`, `agentprism modules`; built-ins are plugins too.
- Pricing: list prices 2026-10-06, long-prompt tier, local overrides; `ap_cost()` registered in SQL (D17, D18).
- `report` (spend by project/model/day/session/prompt, cache savings, cost by token kind).
- 8 detectors with evidence + suggestion; `findings`; `mark` + `compare` for before/after.
- 34 tests (pricing ≡ SQL, every detector, registry/plugin loading, compare).
- Baseline written to `METRICS.md`.

**Found**

- ~60% of the author's $836 (API-eq.) is estimated waste, almost all from **session length**:
  context growth $393, cache rebuilds after breaks $101. Tools/loops/reads are cheap ($8 together).
- Image tool results are base64: measuring them by characters overstated them ~100× (first version
  reported $471 waste for a $109 session). Fixed: images counted separately; waste capped per session.
- Claude Code already de-duplicates unchanged re-reads, so repeated reads cost little.

**Next**

- User applies the top suggestion (one task per session, fresh session after breaks) and runs
  `agentprism mark "short sessions"`; re-measure in a week.
- M4: split compare by call time. M5: fix modules that write CLAUDE.md / permission patches.
- M6: SDK + adapter for the user's own AI products.

---

## 2026-10-23 — M1 Foundation

**Done**

- Name confirmed: AgentPrism. Launch plan written (`LAUNCH.md`).
- npm workspaces monorepo (pnpm was not installed; npm needs no extra tool — D12).
- `core`: normalized schema, plugin interfaces, SQLite store with incremental, idempotent ingest, overview query.
- `adapter-claude-code`: streaming, tolerant parser; fast-skips heavy record types before JSON.parse.
- `agentprism` CLI: `scan` with a terminal summary and `--json`. Zero runtime dependencies, 32 KB bundle.
- 13 tests on synthetic fixtures; CI for Linux/macOS/Windows × Node 22/24 (not yet run — no remote).

**Found (on the author's 408 MB of logs)**

- First scan 2.9 s, incremental re-scan 0.14 s — well inside the VISION targets (15 s / 1 s).
- Resumed sessions copy history into new files with the original `sessionId`: 2,770 duplicated requests.
  Global de-duplication by `requestId` is required (and implemented).
- Tool-use blocks also repeat: 15,769 on disk, 6,727 unique.
- `cost-state` is partial (not written on every run); our transcript totals match it within 0.3%
  where it covers the full session. Treat it as a cross-check only.
- 98.9% of all tokens are cache reads. Main-model calls only; internal Haiku calls are not in transcripts.

**Next**

- First commit — needs the git author name/email from the user.
- M2: price table and API-equivalent cost, breakdowns, baseline in METRICS.md.

---

## 2026-10-23 — M0 Product definition (bar raised)

**Done**

- Raised the ambition: flagship open-source devtool, target 1,000+ stars, room to grow into a platform.
- Wrote VISION.md and ROADMAP.md (v0.1 → v1.0 + launch plan); reworked PLAN.md for v0.1 in ~16h.
- Architecture: pnpm monorepo, plugin interfaces (Adapter / Detector / Fix), OTel-aligned schema.
- Shape decided: CLI + local web app via `npx agentprism`, no Electron (D11).
- Renamed AgentLens → AgentPrism (D10, waiting for user confirmation).

**Found**

- Crowded "usage counter" space: ccusage (~10k stars), ccboard, ccost, tokentrail, agentxray, agentscope.
  Our edge is why → fix → proof, cross-agent comparison, AI-code outcomes (D9).
- npm: `agentlens` taken, `agentprism` free.

**Next**

- User confirms the name → first commit → M1 Foundation.

---

## 2026-10-23 — M0 Setup

**Done**

- Chose the project: AgentLens (after considering a real-time voice translator, dropped).
- Inspected local Claude Code logs: 6 project folders, 34 session files, ~408 MB.
- Wrote working docs and initialized git.

**Found**

- Every assistant record carries `message.usage` with input, output, cache read/write and thinking tokens.
- `cost-state` records carry Claude Code's own `totalCostUSD` and lines added/removed — useful to cross-check our cost math.
- One API response is spread over several JSONL lines (one per content block) — usage must be de-duplicated.
- Details in `docs/LOG_FORMAT.md`.

**Next**

- First commit (needs the user's OK).
- Start M1: TypeScript skeleton, then the parser.
