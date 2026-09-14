import Tooltip, { type TooltipSide } from './Tooltip'

interface Props {
  orientation: 'horizontal' | 'vertical'
  active: boolean
  tooltip: string
  tooltipSide?: TooltipSide
  onMouseDown?: (e: React.MouseEvent<HTMLDivElement>) => void
  onPointerDown?: (e: React.PointerEvent<HTMLDivElement>) => void
  onValueChange?: (value: number) => void
  onReset?: () => void
  keyboardStep?: number
  keyboardDirection?: 1 | -1
  ariaValueNow?: number
  ariaValueMin?: number
  ariaValueMax?: number
  className?: string
}

export default function PanelResizer({
  orientation,
  active,
  tooltip,
  tooltipSide = orientation === 'horizontal' ? 'top' : 'right',
  onMouseDown,
  onPointerDown,
  onValueChange,
  onReset,
  keyboardStep = 10,
  keyboardDirection = 1,
  ariaValueNow,
  ariaValueMin,
  ariaValueMax,
  className = '',
}: Props) {
  return (
    <Tooltip
      label={tooltip}
      side={tooltipSide}
      delay={0}
      wrapperClassName={
        orientation === 'horizontal' ? 'flex w-full shrink-0' : 'flex h-full shrink-0'
      }
    >
      <div
        onMouseDown={onMouseDown}
        onPointerDown={onPointerDown}
        role="separator"
        tabIndex={onValueChange ? 0 : undefined}
        aria-label={tooltip}
        onDoubleClick={onReset}
        onKeyDown={event => {
          if (!onValueChange || ariaValueNow == null) return
          if (event.key === 'Enter' && onReset) {
            event.preventDefault()
            event.stopPropagation()
            onReset()
            return
          }
          const decrease = orientation === 'vertical' ? 'ArrowLeft' : 'ArrowUp'
          const increase = orientation === 'vertical' ? 'ArrowRight' : 'ArrowDown'
          let value: number
          if (event.key === 'Home' && ariaValueMin != null) value = ariaValueMin
          else if (event.key === 'End' && ariaValueMax != null) value = ariaValueMax
          else if (event.key === decrease || event.key === increase) {
            value = ariaValueNow + (event.key === decrease ? -1 : 1) * keyboardDirection * keyboardStep * (event.shiftKey ? 5 : 1)
          } else return
          event.preventDefault()
          event.stopPropagation()
          onValueChange(Math.min(ariaValueMax ?? Infinity, Math.max(ariaValueMin ?? -Infinity, value)))
        }}
        aria-orientation={orientation === 'horizontal' ? 'horizontal' : 'vertical'}
        aria-valuenow={ariaValueNow}
        aria-valuemin={ariaValueMin}
        aria-valuemax={ariaValueMax}
        className={`panel-resizer panel-resizer--${orientation}${active ? ' panel-resizer--active' : ''} ${className}`}
      >
        <span className="panel-resizer-line" aria-hidden />
        <span className="panel-resizer-grip" aria-hidden>
          <span />
          <span />
          <span />
        </span>
      </div>
    </Tooltip>
  )
}
