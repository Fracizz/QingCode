import { describe, expect, it } from 'vitest'
import { tipArrowBoxGap, TIP_ARROW_CLEARANCE, TIP_ARROW_PROTRUDE } from './tipArrow'

/** Viewport gap: trigger top − caret tip bottom. */
function caretTipClearance(triggerTop: number, caretTipBottom: number) {
  return triggerTop - caretTipBottom
}

describe('tipArrowBoxGap', () => {
  it('keeps caret tip 2px above the anchor at zoom=1', () => {
    expect(tipArrowBoxGap(1)).toBe(TIP_ARROW_PROTRUDE + TIP_ARROW_CLEARANCE)
    expect(tipArrowBoxGap(1) - TIP_ARROW_PROTRUDE).toBe(2)
  })

  it('scales caret protrusion with zoom so clearance stays 2px in viewport space', () => {
    const zoom = 16 / 13
    const gap = tipArrowBoxGap(zoom)
    // Visual caret hang = TIP_ARROW_PROTRUDE * zoom; clearance = gap - hang.
    expect(gap - TIP_ARROW_PROTRUDE * zoom).toBeCloseTo(TIP_ARROW_CLEARANCE, 6)
  })

  it('documents the target clearance used by StatusTip / encoding menu', () => {
    const statusBarRowTop = 700
    const tipBoxBottom = statusBarRowTop - tipArrowBoxGap(1)
    const caretTipBottom = tipBoxBottom + TIP_ARROW_PROTRUDE
    expect(caretTipClearance(statusBarRowTop, caretTipBottom)).toBe(TIP_ARROW_CLEARANCE)
    expect(TIP_ARROW_CLEARANCE).toBe(2)
  })
})
