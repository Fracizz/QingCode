/** Missing or blank preferences must not become Number(null) = 0. */
export function parseTerminalPaneRatio(value: string | null): number {
  if (value == null || value.trim() === '') return 0.5
  const ratio = Number(value)
  return Number.isFinite(ratio) ? Math.min(0.9, Math.max(0.1, ratio)) : 0.5
}
