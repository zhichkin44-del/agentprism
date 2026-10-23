import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import type { Adapter, Detector, Fix, Plugin } from "./plugin.js";

/** Holds every loaded module. The CLI only ever talks to modules through this. */
export class Registry {
  readonly plugins: Plugin[] = [];
  readonly adapters: Adapter[] = [];
  readonly detectors: Detector[] = [];
  readonly fixes: Fix[] = [];

  use(plugin: Plugin): this {
    for (const [kind, list, items] of [
      ["adapter", this.adapters, plugin.adapters ?? []],
      ["detector", this.detectors, plugin.detectors ?? []],
      ["fix", this.fixes, plugin.fixes ?? []],
    ] as const) {
      for (const item of items) {
        if ((list as { id: string }[]).some((existing) => existing.id === item.id)) {
          throw new Error(`Plugin "${plugin.name}": duplicate ${kind} id "${item.id}"`);
        }
        (list as unknown[]).push(item);
      }
    }
    this.plugins.push(plugin);
    return this;
  }

  /**
   * Loads a plugin by file path or package name. The module's default export must be a Plugin
   * (or a function returning one).
   */
  async load(specifier: string): Promise<Plugin> {
    // A file on disk wins over a package of the same name, so `plugins/x.mjs` works without `./`.
    const isPath =
      specifier.startsWith(".") || path.isAbsolute(specifier) || fs.existsSync(specifier);
    const url = isPath ? pathToFileURL(path.resolve(specifier)).href : specifier;
    const mod = (await import(url)) as { default?: unknown };
    const exported = typeof mod.default === "function" ? await mod.default() : mod.default;
    if (!exported || typeof exported !== "object" || !("name" in exported)) {
      throw new Error(`${specifier}: default export is not an AgentPrism plugin`);
    }
    const plugin = exported as Plugin;
    this.use(plugin);
    return plugin;
  }
}
