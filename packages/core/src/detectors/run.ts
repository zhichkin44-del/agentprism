import type { AnalysisContext, Detector, Finding } from "../plugin.js";
import { invalidateCallCosts } from "./util.js";

export interface DetectorRun {
  detector: Detector;
  findings: Finding[];
  durationMs: number;
  /** Set when the module threw; the other detectors still run. */
  error?: string;
}

/** Runs every detector in isolation and returns findings ranked by estimated waste. */
export async function runDetectors(
  detectors: Detector[],
  ctx: AnalysisContext,
): Promise<DetectorRun[]> {
  invalidateCallCosts(ctx.store);
  const only = ctx.sessionIds ? new Set(ctx.sessionIds) : undefined;
  const runs: DetectorRun[] = [];
  for (const detector of detectors) {
    const started = performance.now();
    try {
      const findings = (await detector.run(ctx))
        .filter((f) => !only || only.has(f.sessionId))
        .sort((a, b) => b.wastedUsd - a.wastedUsd);
      runs.push({ detector, findings, durationMs: performance.now() - started });
    } catch (err) {
      runs.push({
        detector,
        findings: [],
        durationMs: performance.now() - started,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
  return runs;
}
