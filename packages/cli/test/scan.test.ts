import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { claudeCodeAdapter } from "@agentprism/adapter-claude-code";
import { Store, overview } from "@agentprism/core";
import { scan } from "../src/scan.js";

const ROOT = path.join(
  import.meta.dirname,
  "..",
  "..",
  "adapter-claude-code",
  "test",
  "fixtures",
  "projects",
);

describe("scan → store → overview", () => {
  it("counts every request once across split lines, subagent files and copied history", async () => {
    const store = Store.open(":memory:");
    const result = await scan(store, [claudeCodeAdapter({ root: ROOT })]);
    const o = overview(store);

    expect(result.files).toBe(3);
    expect(o.sessions).toBe(2);
    expect(o.projects).toBe(1);
    expect(o.turns).toBe(3);
    expect(o.apiCalls).toBe(5);
    expect(o.subagentCalls).toBe(1);
    expect(o.tokens).toEqual({
      input: 21,
      output: 380,
      thinking: 50,
      cacheRead: 20100,
      cacheWrite: 1300,
      total: 21 + 380 + 20100 + 1300,
    });
    expect(o.toolCalls).toBe(3);
    expect(o.toolErrors).toBe(2);
    expect(o.toolDenials).toBe(1);
    expect(o.compactions).toBe(1);
    expect(o.interrupts).toBe(1);
    expect(o.reportedCostUsd).toBeCloseTo(1.23);
    expect(o.firstAt).toBe(Date.parse("2026-10-01T10:00:01.000Z"));
    store.close();
  });

  it("is incremental: an unchanged scan reads nothing, a full scan gives the same totals", async () => {
    const store = Store.open(":memory:");
    const adapters = [claudeCodeAdapter({ root: ROOT })];
    await scan(store, adapters);
    const before = overview(store);

    expect((await scan(store, adapters)).changed).toBe(0);
    expect((await scan(store, adapters, { full: true })).changed).toBe(3);
    expect(overview(store)).toEqual(before);
    store.close();
  });

  it("returns an empty overview when there are no logs", async () => {
    const store = Store.open(":memory:");
    const missing = path.join(ROOT, "does-not-exist");
    expect(fs.existsSync(missing)).toBe(false);
    const result = await scan(store, [claudeCodeAdapter({ root: missing })]);
    expect(result.files).toBe(0);
    expect(overview(store).sessions).toBe(0);
    store.close();
  });
});
