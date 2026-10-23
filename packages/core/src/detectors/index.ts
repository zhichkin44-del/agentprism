import { definePlugin } from "../plugin.js";
import { cacheRebuilds } from "./cache-rebuilds.js";
import { contextGrowth } from "./context-growth.js";
import { failingTools } from "./failing-tools.js";
import { loops } from "./loops.js";
import { oversizedOutputs } from "./oversized-outputs.js";
import { permissionFriction } from "./permission-friction.js";
import { duplicateRequests, uncachedPrompts, unstablePrefix } from "./prompt-caching.js";
import { rediscovery, repeatedReads } from "./repeated-reads.js";

/** Built-in detectors, shipped as a plugin like any third-party one. */
export const coreDetectors = definePlugin({
  name: "core-detectors",
  detectors: [
    contextGrowth,
    cacheRebuilds,
    oversizedOutputs,
    loops,
    failingTools,
    repeatedReads,
    rediscovery,
    permissionFriction,
    uncachedPrompts,
    unstablePrefix,
    duplicateRequests,
  ],
});
