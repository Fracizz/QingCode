import { createContext } from 'react'

/** Pause every nested tooltip while its interaction scope is being dragged. */
export const TooltipSuppressionContext = createContext(false)
