import { createHash } from "node:crypto";
import { emptyUsage, type AgentEvent, type ReadStats, type TokenUsage } from "@agentprism/core";

/**
 * Record types we know and deliberately ignore. They are skipped before JSON.parse,
 * which matters: `api-request-blob` lines alone are a large share of the bytes.
 * See docs/LOG_FORMAT.md.
 */
const IGNORED_TYPES = new Set([
  "attachment",
  "queue-operation",
  "last-prompt",
  "agent-name",
  "atis-latch",
  "mode",
  "bridge-session",
  "frame-link",
  "file-history-snapshot",
  "file-history-delta",
  "api-request",
  "api-request-blob",
  "api-request-shape",
  "artifact-comment-monitor",
  "artifact-autoreact-ledger",
  "summary",
  // Session moved to another folder; records keep their own `cwd`, so nothing to do.
  "relocated",
  // Restored history hidden from another account; bookkeeping only.
  "history-suppression",
]);

const HANDLED_TYPES = new Set(["user", "assistant", "system", "cost-state", "custom-title"]);

const LEADING_TYPE = /^\{"type":"([^"]+)"/;
const INTERRUPT_PREFIX = "[Request interrupted by user";
const TARGET_FIELDS = [
  "file_path",
  "notebook_path",
  "path",
  "command",
  "pattern",
  "url",
  "query",
  "description",
];
const MAX_TARGET_CHARS = 200;

/* The log format is undocumented, so records are read defensively as loose JSON. */
type Json = Record<string, unknown>;
type Block = Json & { type?: string };

const str = (x: unknown): string | undefined => (typeof x === "string" ? x : undefined);
const num = (x: unknown): number => (typeof x === "number" && Number.isFinite(x) ? x : 0);
const obj = (x: unknown): Json | undefined =>
  x !== null && typeof x === "object" && !Array.isArray(x) ? (x as Json) : undefined;
const blocks = (content: unknown): Block[] =>
  Array.isArray(content) ? (content.filter((b) => obj(b)) as Block[]) : [];

function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  return blocks(content)
    .map((b) => str(b.text) ?? "")
    .join("\n");
}

function charsOf(content: unknown): number {
  if (typeof content === "string") return content.length;
  if (content === undefined || content === null) return 0;
  return JSON.stringify(content).length;
}

/**
 * Size of a tool result as the model sees it: text by length, images by count. Images arrive as
 * base64, so measuring their characters would overstate them by two orders of magnitude.
 */
export function measureResult(content: unknown): { chars: number; images: number } {
  if (!Array.isArray(content)) return { chars: charsOf(content), images: 0 };
  let chars = 0;
  let images = 0;
  for (const b of blocks(content)) {
    if (b.type === "image") images++;
    else if (b.type === "text") chars += (str(b.text) ?? "").length;
    else chars += charsOf(b);
  }
  return { chars, images };
}

export function mapUsage(raw: unknown): TokenUsage {
  const u = obj(raw);
  const usage = emptyUsage();
  if (!u) return usage;
  usage.inputTokens = num(u.input_tokens);
  usage.outputTokens = num(u.output_tokens);
  usage.thinkingTokens = num(obj(u.output_tokens_details)?.thinking_tokens);
  usage.cacheReadTokens = num(u.cache_read_input_tokens);
  const byTtl = obj(u.cache_creation);
  if (byTtl) {
    usage.cacheWrite5mTokens = num(byTtl.ephemeral_5m_input_tokens);
    usage.cacheWrite1hTokens = num(byTtl.ephemeral_1h_input_tokens);
  } else {
    usage.cacheWrite5mTokens = num(u.cache_creation_input_tokens);
  }
  usage.webSearchRequests = num(obj(u.server_tool_use)?.web_search_requests);
  return usage;
}

function toolTarget(input: Json | undefined): string | undefined {
  if (!input) return undefined;
  for (const field of TARGET_FIELDS) {
    const value = str(input[field]);
    if (value) return value.replace(/\s+/g, " ").trim().slice(0, MAX_TARGET_CHARS);
  }
  return undefined;
}

function hashInput(input: unknown): string {
  return createHash("sha1")
    .update(JSON.stringify(input ?? null))
    .digest("hex")
    .slice(0, 16);
}

/**
 * Turns the records of one JSONL file into normalized events. Stateful per file:
 * it tracks the current turn of each session and de-duplicates API calls, because one
 * response is written as several lines that repeat the same usage.
 */
export class RecordParser {
  private readonly seenSessions = new Set<string>();
  private readonly seenCalls = new Set<string>();
  private readonly currentTurn = new Map<string, string>();
  private turnCounter = 0;
  private lastTs = 0;

  constructor(private readonly stats: ReadStats) {}

  parseLine(line: string): AgentEvent[] {
    this.stats.lines++;
    if (!line) return [];

    const leading = LEADING_TYPE.exec(line)?.[1];
    if (leading && IGNORED_TYPES.has(leading)) return [];

    let record: Json;
    try {
      const parsed: unknown = JSON.parse(line);
      const o = obj(parsed);
      if (!o) throw new Error("not an object");
      record = o;
    } catch {
      this.stats.badLines++;
      return [];
    }
    return this.parseRecord(record);
  }

  parseRecord(o: Json): AgentEvent[] {
    const type = str(o.type) ?? "(none)";
    if (IGNORED_TYPES.has(type)) return [];
    if (!HANDLED_TYPES.has(type)) {
      this.stats.unknownTypes.set(type, (this.stats.unknownTypes.get(type) ?? 0) + 1);
      return [];
    }

    const sessionId = str(o.sessionId);
    if (!sessionId) return [];
    const ts = Date.parse(str(o.timestamp) ?? "");
    if (Number.isFinite(ts)) this.lastTs = ts;

    const out: AgentEvent[] = [];
    if (!this.seenSessions.has(sessionId) && str(o.cwd)) {
      this.seenSessions.add(sessionId);
      out.push({
        kind: "session",
        sessionId,
        projectPath: str(o.cwd),
        agentVersion: str(o.version),
        gitBranch: str(o.gitBranch),
        entrypoint: str(o.entrypoint),
      });
    }

    switch (type) {
      case "user":
        this.parseUser(o, sessionId, out);
        break;
      case "assistant":
        this.parseAssistant(o, sessionId, out);
        break;
      case "system":
        this.parseSystem(o, sessionId, out);
        break;
      case "cost-state":
        out.push({
          kind: "session_totals",
          sessionId,
          costUsd: num(o.totalCostUSD),
          linesAdded: num(o.totalLinesAdded),
          linesRemoved: num(o.totalLinesRemoved),
          durationMs: num(o.totalDuration),
          apiDurationMs: num(o.totalAPIDuration),
          toolDurationMs: num(o.totalToolDuration),
        });
        break;
      case "custom-title": {
        const title = str(o.customTitle);
        if (title) out.push({ kind: "session", sessionId, title });
        break;
      }
    }
    return out;
  }

  private subagentOf(o: Json): string | undefined {
    return o.isSidechain === true ? (str(o.agentId) ?? "sidechain") : undefined;
  }

  private parseUser(o: Json, sessionId: string, out: AgentEvent[]): void {
    const message = obj(o.message);
    const content = message?.content;
    const results = blocks(content).filter((b) => b.type === "tool_result");

    for (const r of results) {
      const toolUseId = str(r.tool_use_id);
      if (!toolUseId) continue;
      const size = measureResult(r.content);
      out.push({
        kind: "tool_result",
        sessionId,
        toolUseId,
        ts: this.lastTs,
        resultChars: size.chars,
        resultImages: size.images,
        isError: r.is_error === true,
        denial: str(o.toolDenialKind),
      });
    }
    if (results.length > 0) return;
    if (o.isMeta === true || o.isCompactSummary === true || o.isSidechain === true) return;

    const text = textOf(content);
    if (text.startsWith(INTERRUPT_PREFIX)) {
      out.push({
        kind: "marker",
        sessionId,
        turnId: this.currentTurn.get(sessionId),
        ts: this.lastTs,
        type: "interrupt",
      });
      return;
    }

    const turnId = str(o.promptId) ?? str(o.uuid);
    if (!turnId) return;
    // One prompt can span several records (text + image); keep the first.
    if (this.currentTurn.get(sessionId) === turnId) return;
    this.currentTurn.set(sessionId, turnId);
    const position = obj(o.turnPosition);
    out.push({
      kind: "turn",
      sessionId,
      turnId,
      index: num(position?.turnIndex) || ++this.turnCounter,
      ts: this.lastTs,
      promptChars: text.length,
      origin: str(obj(o.origin)?.kind) ?? "human",
    });
  }

  private parseAssistant(o: Json, sessionId: string, out: AgentEvent[]): void {
    const message = obj(o.message);
    if (!message) return;
    const model = str(message.model) ?? "unknown";
    // Synthetic messages are client-side placeholders (errors, refusals), not model calls.
    if (model === "<synthetic>" || o.isApiErrorMessage === true) return;

    const callId = str(o.requestId) ?? str(message.id);
    if (!callId) return;
    const turnId = o.isSidechain === true ? undefined : this.currentTurn.get(sessionId);
    const subagentId = this.subagentOf(o);

    if (!this.seenCalls.has(callId)) {
      this.seenCalls.add(callId);
      out.push({
        kind: "api_call",
        sessionId,
        turnId,
        callId,
        ts: this.lastTs,
        model,
        usage: mapUsage(message.usage),
        stopReason: str(message.stop_reason),
        subagentId,
      });
    }

    for (const b of blocks(message.content)) {
      if (b.type !== "tool_use") continue;
      const toolUseId = str(b.id);
      const name = str(b.name);
      if (!toolUseId || !name) continue;
      const input = obj(b.input);
      out.push({
        kind: "tool_call",
        sessionId,
        turnId,
        callId,
        toolUseId,
        ts: this.lastTs,
        name,
        mcpServer: name.startsWith("mcp__") ? name.split("__")[1] : undefined,
        inputChars: charsOf(b.input),
        target: toolTarget(input),
        inputHash: hashInput(b.input),
        subagentId,
      });
    }
  }

  private parseSystem(o: Json, sessionId: string, out: AgentEvent[]): void {
    const turnId = this.currentTurn.get(sessionId);
    switch (str(o.subtype)) {
      case "compact_boundary": {
        const meta = obj(o.compactMetadata);
        out.push({
          kind: "marker",
          sessionId,
          turnId,
          ts: this.lastTs,
          type: "compaction",
          data: {
            trigger: str(meta?.trigger),
            preTokens: num(meta?.preTokens),
            postTokens: num(meta?.postTokens),
          },
        });
        break;
      }
      case "api_error":
        out.push({ kind: "marker", sessionId, turnId, ts: this.lastTs, type: "api_error" });
        break;
      case "model_refusal_fallback":
        out.push({ kind: "marker", sessionId, turnId, ts: this.lastTs, type: "refusal_fallback" });
        break;
    }
  }
}
