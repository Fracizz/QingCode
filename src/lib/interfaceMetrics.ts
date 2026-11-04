/** Integer CSS pixels: UI typography and layout grow without a CSS zoom layer. */
export const INTERFACE_BASE_FONT_SIZE = 13

export function normalizeInterfaceFontSize(size: number): number {
  return Number.isFinite(size) ? Math.min(32, Math.max(10, Math.round(size))) : INTERFACE_BASE_FONT_SIZE
}

export function interfacePixelSize(pixels: number, fontSize: number): number {
  return Math.round(pixels * normalizeInterfaceFontSize(fontSize) / INTERFACE_BASE_FONT_SIZE)
}

export function interfaceMetrics(size: number) {
  const fontSize = normalizeInterfaceFontSize(size)
  const pixels = (baseline: number) => interfacePixelSize(baseline, fontSize)
  return {
    fontSize,
    smallFontSize: Math.max(10, fontSize - 1),
    lineHeight: Math.round(fontSize * 1.5),
    controlHeight: pixels(26),
    rowHeight: pixels(26),
    createRowHeight: pixels(30),
    scmRowHeight: pixels(28),
    chipHeight: pixels(24),
    tabHeight: pixels(32),
    titleHeight: pixels(32),
    statusHeight: pixels(24),
    activityWidth: pixels(48),
    activityButtonSize: pixels(40),
    activityIconSize: pixels(22),
  }
}
