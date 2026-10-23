import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { Store, coreDetectors, overview, runDetectors, spend } from "@agentprism/core";
import { FileSink, agentprism } from "@agentprism/sdk";
import { tracesAdapter } from "../src/index.js";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agentprism-traces-"));
afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

let n = 0;
/** Fake client that answers with fixed usage: a big uncached prompt every time. */
const client = {
  messages: {
    create: (p: { model: string }) =>
      Promise.resolve({
        id: `msg_${++n}`,
        model: p.model,
        stop_reason: "end_turn",
        content: [{ type: "text", text: "ok" }],
        usage: { input_tokens: 10_000, output_tokens: 50 },
      }),
  },
};

const request = (question: string) => ({
  model: "claude-opus-5-5",
  max_tokens: 200,
  system: "Long, stable support-bot instructions…",
  messages: [{ role: "user", content: question }],
});

describe("SDK traces → store → detectors", () => {
  it("analyses an app traced with the SDK end to end", async () => {
    const prism = agentprism({ app: "support-bot", sink: new FileSink(dir) });
    const bot = prism.instrument(client);
    await prism.withSession("conv-1", async () => {
      await prism.withAgent("triage", () => bot.messages.create(request("Where is my order?")));
      await prism.withAgent("triage", () => bot.messages.create(request("Where is my order?")));
      await prism.withAgent("triage", () => bot.messages.create(request("How do I return it?")));
      await prism.tool("lookup-order", () => ({ status: "shipped" }), { input: { id: 42 } });
    });
    await new Promise((r) => setTimeout(r, 10));

    const store = Store.open(":memory:");
    const adapter = tracesAdapter({ dir });
    const files = await adapter.discover();
    expect(files).toHaveLength(1);
    for (const f of files)
      await store.ingest(f, adapter.read(f, { lines: 0, badLines: 0, unknownTypes: new Map() }));
    store.finalize();

    const o = overview(store);
    expect(o).toMatchObject({ sessions: 1, apiCalls: 3, toolCalls: 1, turns: 3 });
    expect(o.byProject[0]?.project).toBe("app:support-bot");

    const s = spend(store);
    expect(s.byAgent).toEqual([
      expect.objectContaining({ app: "app:support-bot", agent: "triage", calls: 3 }),
    ]);

    const runs = await runDetectors(coreDetectors.detectors ?? [], { store });
    const by = (id: string) => runs.find((r) => r.detector.id === id)?.findings ?? [];
    // Same 10K-token prefix three times with no caching at all.
    expect(by("uncached-prompts")).toHaveLength(1);
    expect(by("uncached-prompts")[0]?.title).toContain("3 calls to claude-opus-5-5");
    // "Where is my order?" was asked twice, word for word.
    expect(by("duplicate-requests")[0]?.title).toBe(
      "1 repeats of 1 identical requests were sent to the model again",
    );
    store.close();
  });
});
