// Writes a local labeling sheet from .agentprism/research/owner-pairs.jsonl: a random sample of pairs
// flagged as corrections and of pairs that were not, for the owner to mark. The labels give the
// classifier's precision and recall, and gold data for an "owner's voice" model. Local only; prints counts.
import fs from "node:fs";
import path from "node:path";

const dir = path.resolve(".agentprism", "research");
const pairs = fs
  .readFileSync(path.join(dir, "owner-pairs.jsonl"), "utf8")
  .split("\n")
  .filter(Boolean)
  .map((l) => JSON.parse(l))
  .filter((p) => p.model_output);

// Deterministic shuffle (seeded), so the sheet is stable between runs.
let seed = 42;
const rnd = () => (seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31;
const sample = (xs, n) =>
  xs
    .map((x) => [rnd(), x])
    .sort((a, b) => a[0] - b[0])
    .slice(0, n)
    .map((x) => x[1]);

const flagged = sample(
  pairs.filter((p) => p.is_correction),
  30,
);
const other = sample(
  pairs.filter((p) => !p.is_correction),
  30,
);
const items = sample([...flagged, ...other], 60);

const clip = (t, n) => (t.length > n ? t.slice(0, n) + " …" : t);
const lines = [
  "# Owner corrections: labeling sheet (local, do not commit)",
  "",
  "For each pair, put x in one box. A correction = the owner points out a mistake, something forgotten,",
  "or an unwanted action of the agent. Error types: forgot_context, wrong, revert, overreach, repeat, other.",
  "",
];
for (const p of items) {
  lines.push(`## ${p.id}`, "");
  lines.push(
    `**Agent did:** ${
      p.model_output.actions
        .slice(0, 8)
        .map((a) => a.tool + (a.target ? ` ${path.basename(a.target)}` : ""))
        .join(", ") || "—"
    }`,
    "",
  );
  lines.push(`**Agent said:** ${clip(p.model_output.text.replace(/\s+/g, " "), 600)}`, "");
  lines.push(`**Owner wrote:** ${clip(p.owner_message.text.replace(/\s+/g, " "), 600)}`, "");
  lines.push("- [ ] correction   type: ____", "- [ ] not a correction", "");
}
fs.writeFileSync(path.join(dir, "review-sheet.md"), lines.join("\n"));
console.log(
  `review sheet: ${items.length} pairs (${flagged.length} flagged, ${other.length} not) → ${path.join(dir, "review-sheet.md")}`,
);
