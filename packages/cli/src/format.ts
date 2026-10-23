import { styleText } from "node:util";

type Style = Parameters<typeof styleText>[0];

const color = process.stdout.isTTY && !process.env.NO_COLOR;
export const paint = (style: Style, text: string): string =>
  color ? styleText(style, text) : text;

export const bold = (t: string) => paint("bold", t);
export const dim = (t: string) => paint("dim", t);
export const accent = (t: string) => paint("magenta", t);
export const warn = (t: string) => paint("yellow", t);

const intl = new Intl.NumberFormat("en-US");
export const int = (n: number): string => intl.format(Math.round(n));

/** 1234 → "1.2K", 1_234_567_890 → "1.23B". */
export function compact(n: number): string {
  const units: [number, string][] = [
    [1e9, "B"],
    [1e6, "M"],
    [1e3, "K"],
  ];
  for (const [size, suffix] of units) {
    if (Math.abs(n) >= size) {
      const value = n / size;
      return `${value.toFixed(value < 10 ? 2 : value < 100 ? 1 : 0)}${suffix}`;
    }
  }
  return String(Math.round(n));
}

export const pct = (part: number, whole: number): string =>
  whole > 0 ? `${((part / whole) * 100).toFixed(1)}%` : "–";

export const usd = (n: number): string =>
  `$${n.toLocaleString("en-US", { maximumFractionDigits: n >= 100 ? 0 : 2 })}`;

export const date = (ms: number | null): string =>
  ms === null ? "–" : new Date(ms).toISOString().slice(0, 10);

export function bar(value: number, max: number, width = 20): string {
  const filled = max > 0 ? Math.max(value > 0 ? 1 : 0, Math.round((value / max) * width)) : 0;
  return accent("█".repeat(filled)) + dim("·".repeat(width - filled));
}

/** Left-pads/right-pads columns so tables line up without a dependency. */
export function table(rows: string[][], align: ("l" | "r")[]): string[] {
  // eslint-disable-next-line no-control-regex
  const visible = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, "").length;
  const widths = align.map((_, i) => Math.max(...rows.map((r) => visible(r[i] ?? ""))));
  return rows.map((r) =>
    r
      .map((cell, i) => {
        const pad = " ".repeat(Math.max(0, (widths[i] ?? 0) - visible(cell)));
        return align[i] === "r" ? pad + cell : cell + pad;
      })
      .join("  "),
  );
}
