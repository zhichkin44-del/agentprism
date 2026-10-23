import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { newReadStats, type AgentEvent } from "@agentprism/core";
import { RecordParser, mapUsage, measureResult } from "../src/index.js";

const FIXTURES = path.join(import.meta.dirname, "fixtures", "projects", "-home-dev-demo-app");

function parseFile(name: string) {
  const stats = newReadStats();
  const parser = new RecordParser(stats);
  const events = fs
    .readFileSync(path.join(FIXTURES, name), "utf8")
    .split("\n")
    .flatMap((line) => parser.parseLine(line));
  return { events, stats };
}

const ofKind = <K extends AgentEvent["kind"]>(events: AgentEvent[], kind: K) =>
  events.filter((e): e is Extract<AgentEvent, { kind: K }> => e.kind === kind);

describe("RecordParser", () => {
  const { events, stats } = parseFile("sess-a.jsonl");

  it("emits one api_call per request even when the response spans several lines", () => {
    const calls = ofKind(events, "api_call");
    expect(calls.map((c) => c.callId)).toEqual(["req_1", "req_2", "req_3"]);
    expect(calls[0]?.usage).toEqual({
      inputTokens: 10,
      outputTokens: 200,
      thinkingTokens: 50,
      cacheReadTokens: 5000,
      cacheWrite5mTokens: 0,
      cacheWrite1hTokens: 1000,
      webSearchRequests: 0,
    });
  });

  it("skips synthetic placeholder messages", () => {
    expect(ofKind(events, "api_call").some((c) => c.model === "<synthetic>")).toBe(false);
  });

  it("creates turns only for real prompts and links calls to them", () => {
    const turns = ofKind(events, "turn");
    expect(turns.map((t) => [t.turnId, t.index, t.origin])).toEqual([
      ["p1", 1, "human"],
      ["p2", 2, "human"],
    ]);
    const calls = ofKind(events, "api_call");
    expect(calls.map((c) => c.turnId)).toEqual(["p1", "p1", "p2"]);
  });

  it("captures tool calls with a readable target and their results", () => {
    const tools = ofKind(events, "tool_call");
    expect(tools.map((t) => [t.name, t.target])).toEqual([
      ["Bash", "npm test"],
      ["Read", "/home/dev/demo-app/src/login.ts"],
    ]);
    expect(tools[0]?.inputHash).toMatch(/^[0-9a-f]{16}$/);

    const results = ofKind(events, "tool_result");
    expect(results.map((r) => [r.toolUseId, r.isError, r.denial])).toEqual([
      ["tu1", true, undefined],
      ["tu2", true, "user-rejected"],
    ]);
  });

  it("records interrupts and compactions as markers", () => {
    const markers = ofKind(events, "marker");
    expect(markers.map((m) => m.type)).toEqual(["interrupt", "compaction"]);
    expect(markers[1]?.data).toEqual({ trigger: "auto", preTokens: 180000, postTokens: 12000 });
  });

  it("reads session metadata, title and the agent's own totals", () => {
    const sessions = ofKind(events, "session");
    expect(sessions).toContainEqual({
      kind: "session",
      sessionId: "sess-a",
      title: "Fix login bug",
    });
    expect(sessions).toContainEqual(
      expect.objectContaining({ projectPath: "/home/dev/demo-app", agentVersion: "2.1.0" }),
    );
    expect(ofKind(events, "session_totals")[0]).toMatchObject({ costUsd: 1.23, linesAdded: 12 });
  });

  it("counts unknown record types and broken lines instead of throwing", () => {
    expect(Object.fromEntries(stats.unknownTypes)).toEqual({ "brand-new-type": 1 });
    expect(stats.badLines).toBe(1);
  });

  it("attributes subagent traffic to the subagent, not to a main-chain turn", () => {
    const sub = parseFile(path.join("sess-a", "subagents", "agent-x1.jsonl")).events;
    expect(ofKind(sub, "turn")).toEqual([]);
    expect(ofKind(sub, "api_call")[0]).toMatchObject({ subagentId: "x1", turnId: undefined });
    expect(ofKind(sub, "tool_call")[0]).toMatchObject({ name: "Grep", subagentId: "x1" });
  });
});

describe("mapUsage", () => {
  it("falls back to a single cache-write figure when the TTL split is missing", () => {
    expect(mapUsage({ cache_creation_input_tokens: 300 })).toMatchObject({
      cacheWrite5mTokens: 300,
      cacheWrite1hTokens: 0,
    });
  });

  it("returns zeros for missing usage", () => {
    expect(mapUsage(undefined).outputTokens).toBe(0);
  });
});

describe("measureResult", () => {
  it("counts images instead of their base64 size", () => {
    const content = [
      { type: "text", text: "screenshot attached" },
      {
        type: "image",
        source: { type: "base64", media_type: "image/png", data: "A".repeat(500_000) },
      },
    ];
    expect(measureResult(content)).toEqual({ chars: 19, images: 1 });
  });

  it("measures plain string results by length", () => {
    expect(measureResult("ok")).toEqual({ chars: 2, images: 0 });
  });
});
