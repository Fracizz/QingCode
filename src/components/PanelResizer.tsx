import Tooltip, { type TooltipSide } from './Tooltip'

interface Props {
  orientation: 'horizontal' | 'vertical'
  active: boolean
  tooltip: string
  tooltipSide?: TooltipSide
  onMouseDown: (e: React.MouseEvent) => void
  ariaValueNow?: number
  ariaValueMin?: number
  ariaValueMax?: number
}

export default function PanelResizer({
  orientation,
  active,
  tooltip,
  tooltipSide = orientation === 'horizontal' ? 'top' : 'right',
  onMouseDown,
  ariaValueNow,
  ariaValueMin,
  ariaValueMax,
}: Props) {
  return (
    <Tooltip label={tooltip} side={tooltipSide} wrapperClassName="flex">
      <div
        onMouseDown={onMouseDown}
        role="separator"
        aria-orientation={orientation === 'horizontal' ? 'horizontal' : 'vertical'}
        aria-valuenow={ariaValueNow}
        aria-valuemin={ariaValueMin}
        aria-valuemax={ariaValueMax}
        className={`panel-resizer panel-resizer--${orientation}${active ? ' panel-resizer--active' : ''}`}
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
