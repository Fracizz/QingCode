import Tooltip, { type TooltipSide } from './Tooltip'

interface Props {
  orientation: 'horizontal' | 'vertical'
  active: boolean
  tooltip: string
  tooltipSide?: TooltipSide
  onMouseDown?: (e: React.MouseEvent<HTMLDivElement>) => void
  onPointerDown?: (e: React.PointerEvent<HTMLDivElement>) => void
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
      wrapperClassName={orientation === 'horizontal' ? 'flex w-full shrink-0' : 'flex shrink-0'}
    >
      <div
        onMouseDown={onMouseDown}
        onPointerDown={onPointerDown}
        role="separator"
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
