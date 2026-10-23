# AgentPrism trace format v1

What `@agentprism/sdk` writes and `@agentprism/adapter-traces` reads. One JSON object per line,
in `~/.agentprism/traces/<app>/<YYYY-MM-DD>.jsonl` (UTC day). Types: `packages/sdk/src/format.ts`.

Rules: within v1 only optional fields are added; anything else is v2. Readers count unknown
versions/types instead of failing.

## Using the SDK

```ts
import Anthropic from "@anthropic-ai/sdk";
import { agentprism } from "@agentprism/sdk";

const prism = agentprism({ app: "support-bot" }); // capture: "hashes" by default
const client = prism.instrument(new Anthropic());

await prism.withSession(conversationId, () =>
  prism.withAgent("triage", async () => {
    const reply = await client.messages.create({
      model: "claude-opus-5-5",
      max_tokens: 1024,
      messages,
    });
    const order = await prism.tool("lookup-order", () => db.orders.get(id), { input: { id } });
  }),
);
```

Then `agentprism report` / `agentprism findings` include the app next to coding-agent logs.

## Events

### `llm_call`

| Field                                  | Meaning                                                                                                                 |
| -------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| `v`, `type`, `ts`                      | `1`, `"llm_call"`, epoch ms at start                                                                                    |
| `app`, `sessionId`, `turnId?`          | product, conversation/job, one user request                                                                             |
| `agent?`, `parentAgent?`               | multi-agent: who made the call, who started that agent                                                                  |
| `callId`                               | provider message id (a fresh id for answers served by middleware)                                                       |
| `provider`, `model`, `requestedModel?` | answering model; the requested one when a module changed it                                                             |
| `durationMs`, `stream`                 | latency; streamed or not                                                                                                |
| `usage?`                               | `input`, `output`, `thinking`, `cacheRead`, `cacheWrite5m`, `cacheWrite1h`                                              |
| `stopReason?`, `error?`                | `{ type, status?, message? }` on failure (no usage)                                                                     |
| `request`                              | sizes + `prefixHash` (model + tools + system), `promptHash` (whole request), `lastUserHash` (normalized last user text) |
| `response?`                            | `outputChars`, `toolUses`                                                                                               |
| `text?`                                | only with `capture: "text"`: `system`, `lastUser`, `output` (≤ 32K chars each)                                          |
| `middleware?`                          | notes left by modules: `{ cache: { served: true } }`, `{ router: {…} }`                                                 |

### `tool_call`

`toolUseId`, `callId?`, `name`, `durationMs`, `isError`, `inputChars`, `resultChars` + the common fields.

## Behaviour that matters for numbers

- An answer served by middleware (cache) is traced with **zero usage** and a fresh `callId`, so it never
  counts as spend or collides with the original call.
- `after` modules run before the call is recorded; usage always comes from the model's own response.
- `stream: true` and `messages.stream()` are observed without consuming the stream; `after` modules do not
  run on streams.
- Without `withTurn`, every top-level call is treated as one request (turn); sub-agent calls get none.
