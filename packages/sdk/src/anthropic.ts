import type { LlmCallTrace, TraceUsage } from "./format.js";
import { hash, normalizeText } from "./hash.js";

/*
 * Structural view of the Anthropic Messages API: only what tracing reads. The SDK is never
 * imported, so any version works and the app's dependency tree stays as it is (D20).
 */
type Json = Record<string, unknown>;

const obj = (x: unknown): Json | undefined =>
  x !== null && typeof x === "object" && !Array.isArray(x) ? (x as Json) : undefined;
const arr = (x: unknown): unknown[] => (Array.isArray(x) ? x : []);
const num = (x: unknown): number => (typeof x === "number" && Number.isFinite(x) ? x : 0);
const str = (x: unknown): string | undefined => (typeof x === "string" ? x : undefined);

const MAX_TEXT = 32_000;

/** Text of a string or a list of content blocks. */
export function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  return arr(content)
    .map((b) => (obj(b)?.type === "text" ? (str(obj(b)?.text) ?? "") : ""))
    .join("\n");
}

export function lastUserText(messages: unknown): string | undefined {
  const last = arr(messages)
    .map(obj)
    .filter((m): m is Json => m?.role === "user")
    .at(-1);
  if (!last) return undefined;
  const text = textOf(last.content);
  return text || undefined;
}

export function mapUsage(raw: unknown): TraceUsage {
  const u = obj(raw) ?? {};
  const byTtl = obj(u.cache_creation);
  return {
    input: num(u.input_tokens),
    output: num(u.output_tokens),
    thinking: num(obj(u.output_tokens_details)?.thinking_tokens),
    cacheRead: num(u.cache_read_input_tokens),
    cacheWrite5m: byTtl ? num(byTtl.ephemeral_5m_input_tokens) : num(u.cache_creation_input_tokens),
    cacheWrite1h: byTtl ? num(byTtl.ephemeral_1h_input_tokens) : 0,
  };
}

/** The request half of a trace: sizes and hashes, never the text itself. */
export function describeRequest(params: Json): LlmCallTrace["request"] {
  const { stream: _stream, metadata: _metadata, ...rest } = params;
  const tools = arr(params.tools)
    .map((t) => str(obj(t)?.name))
    .filter((n): n is string => !!n);
  const user = lastUserText(params.messages);
  return {
    systemChars: textOf(params.system).length,
    messageCount: arr(params.messages).length,
    promptChars: JSON.stringify(params.messages ?? []).length,
    tools,
    maxTokens: typeof params.max_tokens === "number" ? params.max_tokens : undefined,
    prefixHash: hash({
      model: params.model,
      tools: params.tools ?? null,
      system: params.system ?? null,
    }),
    promptHash: hash(rest),
    lastUserHash: user ? hash(normalizeText(user)) : undefined,
  };
}

export function describeResponse(message: Json): LlmCallTrace["response"] {
  const content = arr(message.content).map(obj);
  return {
    outputChars: textOf(message.content).length,
    toolUses: content
      .filter((b): b is Json => b?.type === "tool_use")
      .map((b) => str(b.name) ?? "tool"),
  };
}

export function captureText(params: Json, message: Json | undefined): LlmCallTrace["text"] {
  const cut = (t: string | undefined) => (t ? t.slice(0, MAX_TEXT) : undefined);
  return {
    system: cut(textOf(params.system) || undefined),
    lastUser: cut(lastUserText(params.messages)),
    output: cut(message ? textOf(message.content) || undefined : undefined),
  };
}

/**
 * Folds streaming events into the message they describe, so a streamed call is traced
 * exactly like a plain one.
 */
export class StreamAccumulator {
  private message: Json = { content: [] };
  private usage: Json = {};
  private texts: string[] = [];
  private tools: string[] = [];

  add(event: unknown): void {
    const e = obj(event);
    switch (e?.type) {
      case "message_start": {
        const m = obj(e.message) ?? {};
        this.message = { ...m };
        this.usage = { ...obj(m.usage) };
        break;
      }
      case "content_block_start": {
        const block = obj(e.content_block);
        if (block?.type === "tool_use") this.tools.push(str(block.name) ?? "tool");
        if (block?.type === "text" && str(block.text)) this.texts.push(str(block.text) ?? "");
        break;
      }
      case "content_block_delta": {
        const delta = obj(e.delta);
        if (delta?.type === "text_delta") this.texts.push(str(delta.text) ?? "");
        break;
      }
      case "message_delta": {
        const delta = obj(e.delta);
        if (delta?.stop_reason) this.message.stop_reason = delta.stop_reason;
        // message_delta carries cumulative counts; keep what message_start had otherwise.
        for (const [k, v] of Object.entries(obj(e.usage) ?? {})) if (v !== null) this.usage[k] = v;
        break;
      }
    }
  }

  result(): Json {
    return {
      ...this.message,
      usage: this.usage,
      content: [
        ...(this.texts.length ? [{ type: "text", text: this.texts.join("") }] : []),
        ...this.tools.map((name) => ({ type: "tool_use", name })),
      ],
    };
  }
}
