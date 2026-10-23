import { randomUUID } from "node:crypto";
import {
  StreamAccumulator,
  captureText,
  describeRequest,
  describeResponse,
  mapUsage,
} from "./anthropic.js";
import { currentContext, withAgent, withContext, withSession, withTurn } from "./context.js";
import { TRACE_VERSION, type LlmCallTrace, type ToolCallTrace } from "./format.js";
import { isOverride, type CallContext, type Middleware } from "./middleware.js";
import { FileSink, type TraceSink } from "./sink.js";

type Json = Record<string, unknown>;

export interface TracerOptions {
  /** Product or service name; traces are grouped by it. */
  app: string;
  /** Where events go (default: JSONL files under ~/.agentprism/traces). */
  sink?: TraceSink;
  /** "hashes" (default) never stores prompt text; "text" does, for evals and cache simulation. */
  capture?: "hashes" | "text";
  /** Session for calls made outside `withSession` (default: one per process). */
  sessionId?: string;
  /** Runtime modules, applied to `messages.create` in order. */
  middleware?: Middleware[];
  tags?: Record<string, string>;
}

/** What the SDK needs from a client: `messages.create`, optionally `messages.stream`. */
export interface MessagesClient {
  messages: {
    create: (params: never, options?: never) => unknown;
    stream?: (params: never, options?: never) => unknown;
  };
}

const now = () => Date.now();
const elapsed = (start: number) => Math.round(performance.now() - start);

/** Thenable with a `then` we can attach to without consuming it (the SDK's APIPromise). */
const isThenable = (x: unknown): x is PromiseLike<unknown> =>
  !!x && typeof (x as { then?: unknown }).then === "function";

export class Tracer {
  readonly app: string;
  readonly sink: TraceSink;
  private readonly options: TracerOptions;
  private readonly defaultSession: string;

  constructor(options: TracerOptions) {
    this.options = options;
    this.app = options.app;
    this.sink = options.sink ?? new FileSink();
    this.defaultSession = options.sessionId ?? `${options.app}-${process.pid}-${now()}`;
  }

  withSession = withSession;
  withTurn = withTurn;
  withAgent = withAgent;
  withContext = withContext;

  /**
   * Returns the client with `messages.create` and `messages.stream` traced (and passed through
   * the middleware). Everything else on the client is untouched.
   */
  instrument<C extends MessagesClient>(client: C): C {
    const messages = client.messages;
    const create = messages.create.bind(messages) as (p: Json, o?: unknown) => unknown;
    const stream = messages.stream?.bind(messages) as
      ((p: Json, o?: unknown) => unknown) | undefined;

    const wrappedMessages = new Proxy(messages, {
      get: (target, prop) => {
        if (prop === "create") return (p: Json, o?: unknown) => this.create(create, p, o);
        if (prop === "stream" && stream) return (p: Json, o?: unknown) => this.stream(stream, p, o);
        const value = Reflect.get(target, prop, target) as unknown;
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    return new Proxy(client, {
      get: (target, prop) => {
        if (prop === "messages") return wrappedMessages;
        const value = Reflect.get(target, prop, target) as unknown;
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
  }

  /** Runs a tool and traces it: duration, failure, sizes. Returns (or rethrows) what `fn` does. */
  async tool<T>(
    name: string,
    fn: () => T | Promise<T>,
    meta: { input?: unknown; callId?: string; toolUseId?: string } = {},
  ): Promise<T> {
    const started = performance.now();
    const ts = now();
    let isError = false;
    let result: unknown;
    try {
      result = await fn();
      return result as T;
    } catch (err) {
      isError = true;
      result = err instanceof Error ? err.message : String(err);
      throw err;
    } finally {
      const event: ToolCallTrace = {
        ...this.base(ts),
        type: "tool_call",
        toolUseId: meta.toolUseId ?? randomUUID(),
        callId: meta.callId,
        name,
        durationMs: elapsed(started),
        isError,
        inputChars: sizeOf(meta.input),
        resultChars: sizeOf(result),
      };
      this.sink.write(event);
    }
  }

  private base(ts: number) {
    const ctx = currentContext();
    const tags = { ...this.options.tags, ...ctx.tags };
    return {
      v: TRACE_VERSION as 1,
      ts,
      app: this.app,
      sessionId: ctx.sessionId ?? this.defaultSession,
      turnId: ctx.turnId,
      agent: ctx.agent,
      parentAgent: ctx.parentAgent,
      tags: Object.keys(tags).length ? tags : undefined,
    };
  }

  private callContext(params: Json): CallContext {
    const ctx = currentContext();
    return {
      app: this.app,
      sessionId: ctx.sessionId ?? this.defaultSession,
      agent: ctx.agent,
      tags: { ...this.options.tags, ...ctx.tags },
      params: { ...params },
      requestedModel: typeof params.model === "string" ? params.model : undefined,
      notes: {},
    };
  }

  private create(original: (p: Json, o?: unknown) => unknown, params: Json, options?: unknown) {
    const mw = this.options.middleware ?? [];
    const ctx = this.callContext(params);
    // Without modules the SDK's own promise is returned untouched (keeps `.withResponse()` etc.).
    if (mw.length === 0) return this.send(original, ctx, options);

    return (async () => {
      for (const m of mw) {
        const r = await m.before?.(ctx);
        if (isOverride(r)) {
          ctx.notes[m.name] = { ...(ctx.notes[m.name] as Json), served: true };
          // Answered without a model call: zero usage, or the saving would be counted as spend.
          this.record(ctx, performance.now(), now(), r.response as Json, false, true);
          return r.response;
        }
      }
      // Streams are observed, not rewritten: `after` modules do not run on them.
      if (ctx.params.stream === true) return this.send(original, ctx, options);

      // Recorded only after every `after` module ran, so the trace carries their notes; usage
      // comes from what the model returned, not from a replacement.
      const started = performance.now();
      const ts = now();
      let modelResponse: unknown;
      try {
        modelResponse = await original(ctx.params, options);
      } catch (err) {
        this.recordError(ctx, started, ts, err);
        throw err;
      }
      let response = modelResponse;
      for (const m of mw) {
        const r = await m.after?.(ctx, response);
        if (isOverride(r)) {
          ctx.notes[m.name] = { ...(ctx.notes[m.name] as Json), replaced: true };
          response = r.response;
        }
      }
      this.record(ctx, started, ts, modelResponse as Json, false);
      return response;
    })();
  }

  /** Calls the model and attaches tracing without consuming or replacing the result. */
  private send(original: (p: Json, o?: unknown) => unknown, ctx: CallContext, options?: unknown) {
    const started = performance.now();
    const ts = now();
    const result = original(ctx.params, options);
    if (!isThenable(result)) return result;

    if (ctx.params.stream === true) {
      result.then(
        (s) => this.observeStream(s, ctx, started, ts),
        (err: unknown) => this.recordError(ctx, started, ts, err),
      );
    } else {
      result.then(
        (message) => this.record(ctx, started, ts, message as Json, false),
        (err: unknown) => this.recordError(ctx, started, ts, err),
      );
    }
    return result;
  }

  private stream(original: (p: Json, o?: unknown) => unknown, params: Json, options?: unknown) {
    const ctx = this.callContext(params);
    const started = performance.now();
    const ts = now();
    const s = original(ctx.params, options) as {
      on?: (event: string, fn: (x: unknown) => void) => unknown;
    };
    s.on?.("finalMessage", (message) => this.record(ctx, started, ts, message as Json, true));
    s.on?.("error", (err) => this.recordError(ctx, started, ts, err));
    return s;
  }

  /** Wraps the stream's iterator in place: the caller iterates as usual, we see every event. */
  private observeStream(s: unknown, ctx: CallContext, started: number, ts: number): void {
    const iterable = s as { [Symbol.asyncIterator]?: () => AsyncIterator<unknown> };
    const iterate = iterable?.[Symbol.asyncIterator];
    if (typeof iterate !== "function") return;
    const acc = new StreamAccumulator();
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      this.record(ctx, started, ts, acc.result(), true);
    };
    iterable[Symbol.asyncIterator] = () => {
      const it = iterate.call(s);
      return {
        next: async (...args: [] | [unknown]) => {
          const r = await it.next(...args);
          if (r.done) finish();
          else acc.add(r.value);
          return r;
        },
        return: async (value?: unknown) => {
          finish();
          return it.return ? it.return(value) : { done: true, value };
        },
        throw: async (err?: unknown) => {
          this.recordError(ctx, started, ts, err);
          done = true;
          if (it.throw) return it.throw(err);
          throw err;
        },
      };
    };
  }

  private record(
    ctx: CallContext,
    started: number,
    ts: number,
    message: Json,
    stream: boolean,
    served = false,
  ) {
    const model = typeof message?.model === "string" ? message.model : String(ctx.params.model);
    const event: LlmCallTrace = {
      ...this.base(ts),
      type: "llm_call",
      // A cached answer repeats an earlier message id; it is a call of its own.
      callId: !served && typeof message?.id === "string" ? message.id : randomUUID(),
      provider: "anthropic",
      model,
      requestedModel: ctx.requestedModel !== model ? ctx.requestedModel : undefined,
      durationMs: elapsed(started),
      stream,
      usage: served ? mapUsage(undefined) : mapUsage(message?.usage),
      stopReason: typeof message?.stop_reason === "string" ? message.stop_reason : undefined,
      request: describeRequest(ctx.params),
      response: describeResponse(message ?? {}),
      text: this.options.capture === "text" ? captureText(ctx.params, message) : undefined,
      middleware: Object.keys(ctx.notes).length ? ctx.notes : undefined,
    };
    this.sink.write(event);
  }

  private recordError(ctx: CallContext, started: number, ts: number, err: unknown) {
    const e = err as { constructor?: { name?: string }; status?: unknown; message?: unknown };
    const event: LlmCallTrace = {
      ...this.base(ts),
      type: "llm_call",
      callId: randomUUID(),
      provider: "anthropic",
      model: String(ctx.params.model),
      durationMs: elapsed(started),
      stream: ctx.params.stream === true,
      error: {
        type: e?.constructor?.name ?? "Error",
        status: typeof e?.status === "number" ? e.status : undefined,
        message: typeof e?.message === "string" ? e.message.slice(0, 200) : undefined,
      },
      request: describeRequest(ctx.params),
      text: this.options.capture === "text" ? captureText(ctx.params, undefined) : undefined,
      middleware: Object.keys(ctx.notes).length ? ctx.notes : undefined,
    };
    this.sink.write(event);
  }
}

function sizeOf(value: unknown): number {
  if (value === undefined || value === null) return 0;
  if (typeof value === "string") return value.length;
  try {
    return JSON.stringify(value).length;
  } catch {
    return 0;
  }
}

/** One-line setup: `const prism = agentprism({ app: "messenger" })`. */
export const agentprism = (options: TracerOptions): Tracer => new Tracer(options);

/** Shortcut when only the client needs tracing. */
export const instrument = <C extends MessagesClient>(client: C, options: TracerOptions): C =>
  new Tracer(options).instrument(client);
