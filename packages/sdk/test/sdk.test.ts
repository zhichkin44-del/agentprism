import { describe, expect, it } from "vitest";
import { MemorySink, agentprism, type LlmCallTrace, type Middleware } from "../src/index.js";

const message = (over: Record<string, unknown> = {}) => ({
  id: `msg_${Math.random().toString(36).slice(2)}`,
  model: "claude-opus-5-5",
  stop_reason: "end_turn",
  content: [{ type: "text", text: "Paris." }],
  usage: {
    input_tokens: 12,
    output_tokens: 3,
    cache_read_input_tokens: 4000,
    cache_creation_input_tokens: 100,
    cache_creation: { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: 100 },
  },
  ...over,
});

/** A stand-in for the Anthropic client: same shape, no network. */
function fakeClient(reply: () => unknown = () => message()) {
  const calls: Record<string, unknown>[] = [];
  return {
    calls,
    other: () => "untouched",
    messages: {
      create(params: Record<string, unknown>) {
        calls.push(params);
        if (params.stream === true) return Promise.resolve(fakeStream());
        return Promise.resolve(reply());
      },
      stream(params: Record<string, unknown>) {
        calls.push(params);
        const handlers = new Map<string, (x: unknown) => void>();
        const s = {
          on(event: string, fn: (x: unknown) => void) {
            handlers.set(event, fn);
            return s;
          },
          emit: (event: string, x: unknown) => handlers.get(event)?.(x),
        };
        return s;
      },
    },
  };
}

function fakeStream() {
  const events = [
    {
      type: "message_start",
      message: {
        id: "msg_stream",
        model: "claude-opus-5-5",
        usage: { input_tokens: 20, cache_read_input_tokens: 900, output_tokens: 1 },
      },
    },
    { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
    { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Hel" } },
    { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "lo" } },
    { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 7 } },
    { type: "message_stop" },
  ];
  return {
    async *[Symbol.asyncIterator]() {
      yield* events;
    },
  };
}

const params = {
  model: "claude-opus-5-5",
  max_tokens: 100,
  system: "You are a geography tutor.",
  messages: [{ role: "user", content: "Capital of  France?" }],
};

const flush = () => new Promise((r) => setTimeout(r, 0));
const calls = (sink: MemorySink) =>
  sink.events.filter((e): e is LlmCallTrace => e.type === "llm_call");

describe("instrument", () => {
  it("traces a plain call without storing prompt text", async () => {
    const sink = new MemorySink();
    const prism = agentprism({ app: "tutor", sink, sessionId: "s1" });
    const client = prism.instrument(fakeClient());
    const reply = (await client.messages.create(params as never)) as { content: unknown[] };
    await flush();

    expect(reply.content).toHaveLength(1);
    const [e] = calls(sink);
    expect(e).toMatchObject({
      app: "tutor",
      sessionId: "s1",
      model: "claude-opus-5-5",
      stream: false,
      stopReason: "end_turn",
      usage: { input: 12, output: 3, cacheRead: 4000, cacheWrite5m: 0, cacheWrite1h: 100 },
      request: { systemChars: 26, messageCount: 1, maxTokens: 100 },
      response: { outputChars: 6, toolUses: [] },
    });
    expect(e?.text).toBeUndefined();
    expect(e?.request.prefixHash).toMatch(/^[0-9a-f]{16}$/);
  });

  it("hashes identical requests and repeated questions identically", async () => {
    const sink = new MemorySink();
    const client = agentprism({ app: "tutor", sink }).instrument(fakeClient());
    await client.messages.create(params as never);
    await client.messages.create({
      ...params,
      messages: [{ role: "user", content: "capital of france?" }],
    } as never);
    await flush();
    const [a, b] = calls(sink);
    expect(a?.request.prefixHash).toBe(b?.request.prefixHash);
    expect(a?.request.promptHash).not.toBe(b?.request.promptHash);
    expect(a?.request.lastUserHash).toBe(b?.request.lastUserHash);
  });

  it("captures text only when asked to", async () => {
    const sink = new MemorySink();
    const client = agentprism({ app: "tutor", sink, capture: "text" }).instrument(fakeClient());
    await client.messages.create(params as never);
    await flush();
    expect(calls(sink)[0]?.text).toEqual({
      system: "You are a geography tutor.",
      lastUser: "Capital of  France?",
      output: "Paris.",
    });
  });

  it("carries session, turn and agent through async code", async () => {
    const sink = new MemorySink();
    const prism = agentprism({ app: "research", sink });
    const client = prism.instrument(fakeClient());
    await prism.withSession("job-7", () =>
      prism.withTurn("t1", () =>
        prism.withAgent("planner", async () => {
          await client.messages.create(params as never);
          await prism.withAgent("searcher", () => client.messages.create(params as never));
        }),
      ),
    );
    await flush();
    expect(calls(sink).map((e) => [e.sessionId, e.turnId, e.agent, e.parentAgent])).toEqual([
      ["job-7", "t1", "planner", undefined],
      ["job-7", "t1", "searcher", "planner"],
    ]);
  });

  it("observes stream: true without consuming the stream", async () => {
    const sink = new MemorySink();
    const client = agentprism({ app: "chat", sink }).instrument(fakeClient());
    const stream = (await client.messages.create({
      ...params,
      stream: true,
    } as never)) as AsyncIterable<{ type: string }>;
    const seen: string[] = [];
    for await (const ev of stream) seen.push(ev.type);
    expect(seen).toHaveLength(6);
    const [e] = calls(sink);
    expect(e).toMatchObject({
      stream: true,
      callId: "msg_stream",
      stopReason: "end_turn",
      usage: { input: 20, output: 7, cacheRead: 900 },
      response: { outputChars: 5 },
    });
  });

  it("traces messages.stream() from its final message", async () => {
    const sink = new MemorySink();
    const client = agentprism({ app: "chat", sink }).instrument(fakeClient());
    const s = client.messages.stream(params as never) as unknown as {
      emit: (e: string, x: unknown) => void;
    };
    s.emit("finalMessage", message({ id: "msg_final" }));
    expect(calls(sink)[0]).toMatchObject({ callId: "msg_final", stream: true });
  });

  it("records failures and still rethrows them to the app", async () => {
    const sink = new MemorySink();
    class RateLimitError extends Error {
      status = 429;
    }
    const client = agentprism({ app: "chat", sink }).instrument(
      fakeClient(() => Promise.reject(new RateLimitError("slow down"))),
    );
    await expect(client.messages.create(params as never)).rejects.toThrow("slow down");
    await flush();
    expect(calls(sink)[0]?.error).toEqual({
      type: "RateLimitError",
      status: 429,
      message: "slow down",
    });
  });

  it("leaves the rest of the client alone", () => {
    const client = agentprism({ app: "x", sink: new MemorySink() }).instrument(fakeClient());
    expect(client.other()).toBe("untouched");
  });
});

describe("middleware", () => {
  it("lets a module reroute a call and notes it on the trace", async () => {
    const sink = new MemorySink();
    const router: Middleware = {
      name: "router",
      before(ctx) {
        ctx.params.model = "claude-haiku-5-5";
        ctx.notes.router = { reason: "short question" };
      },
    };
    const fake = fakeClient((): unknown => message({ model: "claude-haiku-5-5" }));
    const client = agentprism({ app: "chat", sink, middleware: [router] }).instrument(fake);
    await client.messages.create(params as never);
    await flush();
    expect(fake.calls[0]?.model).toBe("claude-haiku-5-5");
    expect(calls(sink)[0]).toMatchObject({
      model: "claude-haiku-5-5",
      requestedModel: "claude-opus-5-5",
      middleware: { router: { reason: "short question" } },
    });
  });

  it("lets a cache answer without calling the model, at zero cost", async () => {
    const sink = new MemorySink();
    const cached = message({ id: "msg_old" });
    const cache: Middleware = { name: "cache", before: () => ({ response: cached }) };
    const fake = fakeClient();
    const client = agentprism({ app: "chat", sink, middleware: [cache] }).instrument(fake);
    expect(await client.messages.create(params as never)).toBe(cached);
    expect(fake.calls).toHaveLength(0);
    const [e] = calls(sink);
    expect(e?.middleware).toEqual({ cache: { served: true } });
    expect(e?.usage).toMatchObject({ input: 0, output: 0, cacheRead: 0 });
    expect(e?.callId).not.toBe("msg_old");
  });

  it("lets a guard replace a response after the call", async () => {
    const sink = new MemorySink();
    const guard: Middleware = {
      name: "guard",
      after: () => ({ response: { blocked: true } }),
    };
    const client = agentprism({ app: "chat", sink, middleware: [guard] }).instrument(fakeClient());
    expect(await client.messages.create(params as never)).toEqual({ blocked: true });
    await flush();
    expect(calls(sink)[0]?.middleware).toEqual({ guard: { replaced: true } });
  });
});

describe("tool", () => {
  it("traces a tool run and passes its result or error through", async () => {
    const sink = new MemorySink();
    const prism = agentprism({ app: "agent", sink });
    expect(await prism.tool("search", () => ["a", "b"], { input: "query" })).toEqual(["a", "b"]);
    await expect(prism.tool("fetch", () => Promise.reject(new Error("404")))).rejects.toThrow(
      "404",
    );
    expect(
      sink.events.map((e) => [
        e.type,
        e.type === "tool_call" && e.name,
        e.type === "tool_call" && e.isError,
      ]),
    ).toEqual([
      ["tool_call", "search", false],
      ["tool_call", "fetch", true],
    ]);
  });
});
