import { createHash } from "node:crypto";

/** JSON with sorted keys, so equal objects hash equally whatever their key order. */
export function stableJson(value: unknown): string {
  return JSON.stringify(value, (_key, v: unknown) =>
    v && typeof v === "object" && !Array.isArray(v)
      ? Object.fromEntries(
          Object.entries(v as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : 1)),
        )
      : v,
  );
}

export const hash = (value: unknown): string =>
  createHash("sha1")
    .update(typeof value === "string" ? value : stableJson(value ?? null))
    .digest("hex")
    .slice(0, 16);

/** Normalizes a question so trivially different spellings hash the same. */
export const normalizeText = (text: string): string =>
  text.toLowerCase().replace(/\s+/g, " ").trim();
