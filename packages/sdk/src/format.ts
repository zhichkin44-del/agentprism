/**
 * AgentPrism trace format, version 1 — one JSON object per line.
 * Written by the SDK, read by `@agentprism/adapter-traces`. Documented in docs/TRACE_FORMAT.md.
 * Only add optional fields within a version; anything else is a new version.
 */
export const TRACE_VERSION = 1;

export interface TraceUsage {
  /** Uncached input tokens. */
  input: number;
  /** Output tokens, thinking included. */
  output: number;
  thinking: number;
  cacheRead: number;
  cacheWrite5m: number;
  cacheWrite1h: number;
}

interface TraceBase {
  v: 1;
  /** Epoch milliseconds when the call started. */
  ts: number;
  /** Name of the product or service, e.g. "messenger". */
  app: string;
  /** A conversation, job or request the calls belong to. */
  sessionId: string;
  /** One user request inside a session, when the app marks them. */
  turnId?: string;
  /** Agent that made the call, in multi-agent systems. */
  agent?: string;
  /** Agent that started `agent`; absent for the top-level agent. */
  parentAgent?: string;
  tags?: Record<string, string>;
}

export interface LlmCallTrace extends TraceBase {
  type: "llm_call";
  callId: string;
  provider: string;
  /** Model that answered. */
  model: string;
  /** Model the app asked for, when a module (e.g. a router) changed it. */
  requestedModel?: string;
  durationMs: number;
  stream: boolean;
  usage?: TraceUsage;
  stopReason?: string;
  error?: { type: string; status?: number; message?: string };
  request: {
    systemChars: number;
    messageCount: number;
    promptChars: number;
    tools: string[];
    maxTokens?: number;
    /** Hash of model + tools + system prompt: the part providers cache. */
    prefixHash: string;
    /** Hash of the whole request: equal hashes = identical requests. */
    promptHash: string;
    /** Hash of the normalized last user message: repeated questions. */
    lastUserHash?: string;
  };
  response?: { outputChars: number; toolUses: string[] };
  /** Only with `capture: "text"`. */
  text?: { system?: string; lastUser?: string; output?: string };
  /** What middleware modules did to this call (served from cache, rerouted, flagged). */
  middleware?: Record<string, unknown>;
}

export interface ToolCallTrace extends TraceBase {
  type: "tool_call";
  toolUseId: string;
  /** The model call that asked for the tool, when known. */
  callId?: string;
  name: string;
  durationMs: number;
  isError: boolean;
  inputChars: number;
  resultChars: number;
}

export type TraceEvent = LlmCallTrace | ToolCallTrace;
