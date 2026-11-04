import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { SourceFile } from "@agentprism/core";
import { readTimeline } from "../src/index.js";

const DIR = path.join(import.meta.dirname, "fixtures", "projects", "-home-dev-demo-app");
const file = (rel: string): SourceFile => {
  const p = path.join(DIR, rel);
  return { agent: "claude-code", path: p, size: fs.statSync(p).size, mtimeMs: 0 };
};

describe("readTimeline", () => {
  it("reads one main chain with content: de-duplicated, no subagent traffic", async () => {
    const files = [
      file("sess-a.jsonl"),
      file("sess-b.jsonl"),
      file("sess-a/subagents/agent-x1.jsonl"),
    ];
    const t = await readTimeline(files, "sess-a");
    const calls = t.events.filter((e) => e.kind === "call");
    // sess-b repeats req_1 of sess-a (copied history): it must count once.
    expect(calls.map((c) => c.id)).toEqual(["req_1", "req_2", "req_3"]);
    expect(t.events.filter((e) => e.kind === "compaction")).toHaveLength(1);
    const results = t.events.filter((e) => e.kind === "block" && e.type === "tool_result");
    expect(results.length).toBeGreaterThan(0);
    // The model's own output points at the call that produced it.
    const own = t.events.filter((e) => e.kind === "block" && e.byCall);
    expect(own.every((e) => e.kind === "block" && calls.some((c) => c.id === e.byCall))).toBe(true);
  });
});
