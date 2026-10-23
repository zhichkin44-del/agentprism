import path from "node:path";
import { describe, expect, it } from "vitest";
import { Registry, coreDetectors, definePlugin } from "../src/index.js";

describe("Registry", () => {
  it("collects modules from plugins", () => {
    const registry = new Registry().use(coreDetectors);
    expect(registry.detectors.map((d) => d.id)).toContain("loops");
    expect(registry.plugins.map((p) => p.name)).toEqual(["core-detectors"]);
  });

  it("rejects two modules with the same id", () => {
    const registry = new Registry().use(coreDetectors);
    const clash = definePlugin({
      name: "clash",
      detectors: [{ id: "loops", title: "x", description: "x", run: () => [] }],
    });
    expect(() => registry.use(clash)).toThrow(/duplicate detector id "loops"/);
  });

  it("loads a third-party plugin from a file", async () => {
    const registry = new Registry();
    const plugin = await registry.load(path.join(import.meta.dirname, "fixtures", "plugin.mjs"));
    expect(plugin.name).toBe("example-plugin");
    expect(registry.detectors.map((d) => d.id)).toEqual(["always-one"]);
  });
});
