/**
 * Normalized, agent-agnostic events. Adapters translate each agent's log format into these;
 * everything downstream (store, analytics, detectors, UI) only knows this schema.
 *
 * Field names mirror OpenTelemetry GenAI semantic conventions where one exists
 * (noted as `otel:`), so an OTLP exporter is a mapping rather than a redesign.
 */

/** Stable id of the agent that produced the log, e.g. "claude-code". */
export type AgentId = string;

/** Epoch milliseconds. */
export type Millis = number;

export interface TokenUsage {
  /** Uncached input tokens. otel: gen_ai.usage.input_tokens (minus cache) */
  inputTokens: number;
  /** otel: gen_ai.usage.output_tokens (includes thinking) */
  outputTokens: number;
  /** Thinking/reasoning share of outputTokens, when the agent reports it. */
  thinkingTokens: number;
  cacheReadTokens: number;
  /** Cache writes are priced by TTL, so they are kept apart. */
  cacheWrite5mTokens: number;
  cacheWrite1hTokens: number;
  webSearchRequests: number;
}

/** First sighting of a session in a source file. Repeated sightings are merged by the store. */
export interface SessionEvent {
  kind: "session";
  sessionId: string;
  projectPath?: string;
  title?: string;
  agentVersion?: string;
  gitBranch?: string;
  entrypoint?: string;
}

/** A prompt that starts a turn: everything until the next prompt belongs to it. */
export interface TurnEvent {
  kind: "turn";
  sessionId: string;
  turnId: string;
  index: number;
  ts: Millis;
  promptChars: number;
  /** Who started the turn: "human", or a machine origin such as a task notification. */
  origin: string;
}

/** One model request/response. Adapters must emit it once per request, however the log splits it. */
export interface ApiCallEvent {
  kind: "api_call";
  sessionId: string;
  turnId?: string;
  callId: string;
  ts: Millis;
  /** otel: gen_ai.response.model */
  model: string;
  usage: TokenUsage;
  /** otel: gen_ai.response.finish_reasons */
  stopReason?: string;
  /** Set when the call ran in its own context (a subagent) rather than the main chain. */
  subagentId?: string;
  /** Name of the agent that made the call, in multi-agent systems. */
  agent?: string;
  /** Hash of the stable request prefix (system prompt + tools): changes break provider caching. */
  prefixHash?: string;
  /** Hash of the whole request: equal hashes = an identical, cacheable request. */
  promptHash?: string;
  /** Wall-clock latency of the call. */
  durationMs?: number;
}

export interface ToolCallEvent {
  kind: "tool_call";
  sessionId: string;
  turnId?: string;
  callId: string;
  toolUseId: string;
  ts: Millis;
  /** otel: gen_ai.tool.name */
  name: string;
  /** MCP server the tool belongs to, if any. */
  mcpServer?: string;
  inputChars: number;
  /** Short human-readable target (file path, command, URL, pattern), for detectors and the UI. */
  target?: string;
  /** Hash of the full input, to spot identical repeated calls without storing the input. */
  inputHash: string;
  subagentId?: string;
  agent?: string;
}

export interface ToolResultEvent {
  kind: "tool_result";
  sessionId: string;
  toolUseId: string;
  ts: Millis;
  /** Text size of the result; images are counted separately, not by their base64 size. */
  resultChars: number;
  resultImages: number;
  isError: boolean;
  /** Why the call was not run, e.g. "user-rejected", "permission-rule". */
  denial?: string;
}

export type MarkerType = "compaction" | "api_error" | "interrupt" | "refusal_fallback";

/** Notable moments in a session that are not calls. */
export interface MarkerEvent {
  kind: "marker";
  sessionId: string;
  turnId?: string;
  ts: Millis;
  type: MarkerType;
  data?: Record<string, unknown>;
}

/** Totals the agent itself reports for a session (used to cross-check our own math). */
export interface SessionTotalsEvent {
  kind: "session_totals";
  sessionId: string;
  costUsd?: number;
  linesAdded?: number;
  linesRemoved?: number;
  durationMs?: number;
  apiDurationMs?: number;
  toolDurationMs?: number;
}

export type AgentEvent =
  | SessionEvent
  | TurnEvent
  | ApiCallEvent
  | ToolCallEvent
  | ToolResultEvent
  | MarkerEvent
  | SessionTotalsEvent;

export function emptyUsage(): TokenUsage {
  return {
    inputTokens: 0,
    outputTokens: 0,
    thinkingTokens: 0,
    cacheReadTokens: 0,
    cacheWrite5mTokens: 0,
    cacheWrite1hTokens: 0,
    webSearchRequests: 0,
  };
}
