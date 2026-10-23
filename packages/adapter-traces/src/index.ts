import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";
import {
  emptyUsage,
  type Adapter,
  type AgentEvent,
  type ReadStats,
  type SourceFile,
} from "@agentprism/core";
import { defaultTraceDir, TRACE_VERSION, type TraceEvent } from "@agentprism/sdk";

export const TRACES = "agentprism-sdk";

export interface TracesOptions {
  /** Directory to scan instead of the default `~/.agentprism/traces`. */
  dir?: string;
}

/** Reads traces written by `@agentprism/sdk` from the user's own products and agent systems. */
export function tracesAdapter(options: TracesOptions = {}): Adapter {
  const dir = options.dir ?? defaultTraceDir();
  return {
    id: TRACES,
    displayName: "AgentPrism SDK traces",

    async discover(): Promise<SourceFile[]> {
      let entries: fs.Dirent[];
      try {
        entries = await fs.promises.readdir(dir, { recursive: true, withFileTypes: true });
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
        throw err;
      }
      const files = entries
        .filter((e) => e.isFile() && e.name.endsWith(".jsonl"))
        .map((e) => path.join(e.parentPath, e.name));
      return Promise.all(
        files.map(async (file) => {
          const st = await fs.promises.stat(file);
          return { agent: TRACES, path: file, size: st.size, mtimeMs: Math.trunc(st.mtimeMs) };
        }),
      );
    },

    async *read(file: SourceFile, stats: ReadStats): AsyncIterable<AgentEvent> {
      const mapper = new TraceMapper(stats);
      const lines = readline.createInterface({
        input: fs.createReadStream(file.path, { encoding: "utf8" }),
        crlfDelay: Infinity,
      });
      for await (const line of lines) yield* mapper.map(line);
    },
  };
}

/** Maps trace lines to normalized events; stateful per file (sessions and turns seen). */
export class TraceMapper {
  private readonly sessions = new Set<string>();
  private readonly turns = new Map<string, number>();

  constructor(private readonly stats: ReadStats) {}

  map(line: string): AgentEvent[] {
    this.stats.lines++;
    if (!line) return [];
    let e: TraceEvent;
    try {
      e = JSON.parse(line) as TraceEvent;
    } catch {
      this.stats.badLines++;
      return [];
    }
    if (e?.v !== TRACE_VERSION || (e.type !== "llm_call" && e.type !== "tool_call")) {
      const kind = `v${String((e as { v?: unknown })?.v)}:${String((e as { type?: unknown })?.type)}`;
      this.stats.unknownTypes.set(kind, (this.stats.unknownTypes.get(kind) ?? 0) + 1);
      return [];
    }

    const out: AgentEvent[] = [];
    if (!this.sessions.has(e.sessionId)) {
      this.sessions.add(e.sessionId);
      out.push({
        kind: "session",
        sessionId: e.sessionId,
        projectPath: `app:${e.app}`,
        entrypoint: "sdk",
      });
    }
    // A sub-agent's calls run in their own context, like Claude Code's subagents.
    const subagentId = e.parentAgent ? e.agent : undefined;

    if (e.type === "tool_call") {
      const callId = e.callId ?? `tool:${e.toolUseId}`;
      out.push(
        {
          kind: "tool_call",
          sessionId: e.sessionId,
          turnId: e.turnId,
          callId,
          toolUseId: e.toolUseId,
          ts: e.ts,
          name: e.name,
          inputChars: e.inputChars,
          inputHash: e.toolUseId,
          subagentId,
          agent: e.agent,
        },
        {
          kind: "tool_result",
          sessionId: e.sessionId,
          toolUseId: e.toolUseId,
          ts: e.ts + e.durationMs,
          resultChars: e.resultChars,
          resultImages: 0,
          isError: e.isError,
        },
      );
      return out;
    }

    // Without explicit turns, each top-level call is one request of its own.
    const turnId = e.turnId ?? (e.parentAgent ? undefined : e.callId);
    if (turnId && !this.turns.has(turnId)) {
      this.turns.set(turnId, this.turns.size + 1);
      out.push({
        kind: "turn",
        sessionId: e.sessionId,
        turnId,
        index: this.turns.get(turnId) ?? 0,
        ts: e.ts,
        promptChars: e.request.promptChars,
        origin: "app",
      });
    }

    if (e.error) {
      out.push({
        kind: "marker",
        sessionId: e.sessionId,
        turnId,
        ts: e.ts,
        type: "api_error",
        data: { type: e.error.type, status: e.error.status },
      });
      return out;
    }

    const u = e.usage;
    out.push({
      kind: "api_call",
      sessionId: e.sessionId,
      turnId,
      callId: e.callId,
      ts: e.ts,
      model: e.model,
      usage: u
        ? {
            inputTokens: u.input,
            outputTokens: u.output,
            thinkingTokens: u.thinking,
            cacheReadTokens: u.cacheRead,
            cacheWrite5mTokens: u.cacheWrite5m,
            cacheWrite1hTokens: u.cacheWrite1h,
            webSearchRequests: 0,
          }
        : emptyUsage(),
      stopReason: e.stopReason,
      subagentId,
      agent: e.agent,
      prefixHash: e.request.prefixHash,
      promptHash: e.request.promptHash,
      durationMs: e.durationMs,
    });
    return out;
  }
}
