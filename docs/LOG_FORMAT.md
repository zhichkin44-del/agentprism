# Claude Code log format (reverse-engineered)

Undocumented and version-dependent. Observed on Claude Code desktop, October 2026.
Update this file whenever something new is found.

## Location

`~/.claude/projects/<project-folder>/<session-uuid>.jsonl`
The project folder is the cwd with `:`, `\`, `/` replaced by `-` (e.g. `C--AIMCRAFT-Translater`).
One line = one JSON record.

## Record types seen (`type` field)

| type                                                                                                                               | Meaning / useful fields                                                                                                                                                                       |
| ---------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `user`                                                                                                                             | user prompt **or** tool result. `message.content[]` has `text`, `image`, `tool_result`. Also `toolUseResult`, `permissionMode`, `toolDenialKind`, `isCompactSummary`, `isMeta`, `isSidechain` |
| `assistant`                                                                                                                        | model output. `message.content[]` has `thinking`, `text`, `tool_use`. `message.model`, `message.usage`, `requestId`, `effort`, `thinkingDurationMs`, `isApiErrorMessage`, `isSidechain`       |
| `system`                                                                                                                           | hooks, compaction (`compactMetadata`), stop reasons, errors (`level`, `subtype`)                                                                                                              |
| `attachment`                                                                                                                       | context injected into the prompt (files, reminders)                                                                                                                                           |
| `cost-state`                                                                                                                       | Claude Code's own totals: `totalCostUSD`, `totalAPIDuration`, `totalToolDuration`, `totalLinesAdded/Removed`, `modelUsage`                                                                    |
| `api-request`, `api-request-blob`, `api-request-shape`                                                                             | request shape and content blobs (large)                                                                                                                                                       |
| `file-history-snapshot`, `file-history-delta`                                                                                      | file edit history                                                                                                                                                                             |
| `custom-title`, `agent-name`, `last-prompt`, `mode`, `queue-operation`, `bridge-session`, `frame-link`, `atis-latch`, `artifact-*` | session metadata, mostly ignorable                                                                                                                                                            |

Common fields: `uuid`, `parentUuid`, `timestamp`, `sessionId`, `cwd`, `gitBranch`, `version`, `entrypoint`.

## `message.usage` example

```json
{
  "input_tokens": 2,
  "cache_creation_input_tokens": 27655,
  "cache_read_input_tokens": 41544,
  "output_tokens": 434,
  "output_tokens_details": { "thinking_tokens": 86 },
  "cache_creation": { "ephemeral_1h_input_tokens": 27655, "ephemeral_5m_input_tokens": 0 },
  "server_tool_use": { "web_search_requests": 0, "web_fetch_requests": 0 },
  "service_tier": "standard",
  "speed": "standard"
}
```

## More details (verified 2026-10-23 on 34 files / 116k lines)

- **Subagents** write to `<session-uuid>/subagents/agent-<id>.jsonl`. Records there have
  `isSidechain: true`, `agentId`, and the **parent's** `sessionId`.
- **Turns:** prompt records (`user`, not a tool result, not `isMeta`) carry `promptId`,
  `origin.kind` ("human" or machine origins) and `turnPosition: { promptIndex, turnIndex }`.
  Tool results carry the same `promptId` as the prompt they belong to.
- **Interrupts** are `user` text records starting with `[Request interrupted by user` (also `… for tool use]`).
- **Denials:** `toolDenialKind` on the tool-result record: `user-rejected`, `permission-rule`,
  `automode-unavailable`, `automode-blocked`, `cancelled`.
- **System subtypes:** `stop_hook_summary` (most), `compact_boundary` (with `compactMetadata.trigger`,
  `preTokens`, `postTokens`), `api_error`, `model_refusal_fallback`, `informational`.
- **Synthetic messages:** `assistant` records with `model: "<synthetic>"` (or `isApiErrorMessage`) are
  client-side placeholders, not model calls — no usage to count.
- `relocated` (session moved to another cwd) and `history-suppression` records exist; bookkeeping only.

## Gotchas

- **One response, many lines.** An assistant response with thinking + text + tool_use is written as
  several `assistant` records that repeat the same `usage`. De-duplicate by `requestId` (fallback `message.id`),
  otherwise tokens are over-counted several times. Verified on a real session: 3436 assistant lines,
  1205 unique requests (up to 12 lines per request), usage identical on every line — a naive sum
  over-counts ~2.9×.
- **Resumed/forked sessions copy history.** A new session file starts with a copy of the old session's
  records, which keep the **original** `sessionId` and `requestId`. Observed: 2,770 requests present in
  3 files. De-duplicate globally by `requestId` (not per file) and attribute by the record's `sessionId`.
- **Tool-use blocks repeat too**: 15,769 tool_use blocks on disk, 6,727 unique ids. De-duplicate by id.
- **`cost-state` is partial.** It is written on some runs only, so it under-reports for sessions that
  were resumed. Where it covers the whole session, our transcript-based totals match it within 0.3% for
  the main model (the rest is internal Haiku calls that never appear in the transcript). Use it as a
  cross-check, not as ground truth.
- **`cost-state` reveals Claude Code's own price table.** Its `modelUsage[model]` has token counts and
  `costUSD`; solving for prices across sessions (2026-11-04, v2.1.308–309, 98 sessions) gives Sonnet 5.5
  cache reads at **$0.10/M** (0.05× input) and cache writes at the 1h rate — the Sonnet total matches to the
  cent only with those prices. Opus 5.5 matches our table within 1%. Its totals reset per process and on
  `/clear` (v2.1.211+), so they are far below transcript totals for long-lived sessions.

## Request records (v2.1.308+, observed 2026-11-04)

- `api-request` — one per model request (10,326 for 9,790 de-duplicated calls): `params` (model, betas,
  `max_tokens`, `thinking`, `context_management`, `output_config.effort`), `querySource` (`sdk`,
  `agent:builtin:general-purpose`, …), `shapeHash`, `tail` (blob hashes), `cacheControl` (breakpoint paths
  with `ttl` and `scope`), `requestDigest`.
- `api-request-shape` — keyed by `shapeHash` (73 distinct shapes in 12 days): the **full system prompt and
  every tool definition sent** (`name`, `description`, `input_schema`). This gives the exact fixed prefix of
  each call: system prompt, built-in tools, and each MCP server (`mcp__<server>__<tool>`). Observed average:
  ~41K tokens per call (system 7K, built-in tools 22K, MCP ~11K).
- `api-request-blob` — message content addressed by hash (large; the bulk of the bytes).
- Other new metadata types: `pr-link` (`prNumber`, `prUrl`, `prRepository`), `fork-context-ref`. Skipped.
- **Images in tool results** (screenshots, `Read` of an image) arrive as base64 inside `tool_result.content`.
  Measuring them by characters overstates them ~100× (one Read averaged 185K chars). Count images separately
  (~1,600 tokens each) and measure only text by length.
- Tool calls link by id: `assistant … tool_use.id` ↔ `user … tool_result.tool_use_id`.
- `isSidechain: true` marks subagent traffic.
- Cache writes come in two TTL flavours (5m / 1h) with different prices.
- Files can be large (biggest observed ~117 MB) — stream line by line, never `readFileSync` whole.
