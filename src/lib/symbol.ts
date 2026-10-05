/** Canonical trading-code form: trimmed, upper-cased (matches DSE codes). */
export function normalizeSymbol(raw: unknown): string {
  return String(raw ?? "").trim().toUpperCase();
}
