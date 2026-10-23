import { emptyUsage, Store, type AgentEvent, type TokenUsage } from "../src/index.js";

const T0 = Date.parse("2026-10-01T10:00:00.000Z");
export const at = (seconds: number) => T0 + seconds * 1000;

/** Ingests hand-written events into an in-memory store, as if an adapter had read them. */
export async function storeWith(events: AgentEvent[]): Promise<Store> {
  const store = Store.open(":memory:");
  async function* gen() {
    yield* events;
  }
  await store.ingest({ agent: "test", path: "test.jsonl", size: 1, mtimeMs: 1 }, gen());
  store.finalize();
  return store;
}

export interface CallTokens {
  input?: number;
  output?: number;
  cacheRead?: number;
  cacheWrite5m?: number;
  cacheWrite1h?: number;
}

export const usage = (u: CallTokens): TokenUsage => ({
  ...emptyUsage(),
  inputTokens: u.input ?? 0,
  outputTokens: u.output ?? 0,
  cacheReadTokens: u.cacheRead ?? 0,
  cacheWrite5mTokens: u.cacheWrite5m ?? 0,
  cacheWrite1hTokens: u.cacheWrite1h ?? 0,
});

/** Small builder for one session's events. */
export function session(id: string, project = "/work/app") {
  const events: AgentEvent[] = [{ kind: "session", sessionId: id, projectPath: project }];
  let turn: string | undefined;
  let callN = 0;
  let toolN = 0;
  const api = {
    events,
    turn(turnId: string, ts: number) {
      turn = turnId;
      events.push({
        kind: "turn",
        sessionId: id,
        turnId,
        index: 1,
        ts,
        promptChars: 10,
        origin: "human",
      });
      return api;
    },
    call(ts: number, u: CallTokens, callId = `${id}-c${++callN}`) {
      events.push({
        kind: "api_call",
        sessionId: id,
        turnId: turn,
        callId,
        ts,
        model: "claude-opus-5-5",
        usage: usage(u),
      });
      return callId;
    },
    tool(
      callId: string,
      ts: number,
      t: {
        name?: string;
        target?: string;
        hash?: string;
        chars?: number;
        error?: boolean;
        denial?: string;
      },
    ) {
      const toolUseId = `${id}-t${++toolN}`;
      events.push({
        kind: "tool_call",
        sessionId: id,
        turnId: turn,
        callId,
        toolUseId,
        ts,
        name: t.name ?? "Bash",
        target: t.target,
        inputChars: 10,
        inputHash: t.hash ?? toolUseId,
      });
      events.push({
        kind: "tool_result",
        sessionId: id,
        toolUseId,
        ts: ts + 1,
        resultChars: t.chars ?? 100,
        resultImages: 0,
        isError: t.error ?? false,
        denial: t.denial,
      });
      return api;
    },
    marker(type: "compaction" | "interrupt", ts: number) {
      events.push({ kind: "marker", sessionId: id, turnId: turn, ts, type });
      return api;
    },
  };
  return api;
}
