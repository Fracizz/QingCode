import { useState, type MouseEvent, type ReactNode, type Ref } from 'react'
import { Minus, Plus } from 'lucide-react'
import { t } from '@qn/codex-client'
import { cn } from '../lib/cn'
import { IconButton } from './ui'

const ZOOM_LEVELS = [25, 50, 75, 100, 125, 150, 200, 300, 400]
const FIT_INDEX = ZOOM_LEVELS.indexOf(100)

export function ZoomableImage({ src, alt, className, imageRef, allowOriginalSize, onBlankClick, actions }: {
  src: string
  alt: string
  className?: string
  imageRef?: Ref<HTMLImageElement>
  allowOriginalSize?: boolean
  onBlankClick?: () => void
  actions?: ReactNode
}) {
  const [step, setStep] = useState(FIT_INDEX)
  const [originalSize, setOriginalSize] = useState(false)

  function reset(original: boolean) {
    setOriginalSize(original)
    setStep(FIT_INDEX)
  }

  const toolbar = (
    // 工具栏紧贴图片下方；sticky 让放大滚动时它仍停在可视区内，也不会压到窗口右上角的系统按钮。
    <div className="sticky inset-x-0 bottom-0 flex shrink-0 items-center justify-center gap-2 whitespace-nowrap">
      <div role="group" aria-label={t('图片缩放')} className="flex items-center gap-1 rounded-lg border border-qn-border bg-qn-panel px-1 shadow-lg">
        <IconButton label={t('缩小')} tooltip={false} title={t('缩小')} disabled={step === 0}
          onClick={() => setStep((value) => Math.max(0, value - 1))}>
          <Minus size={16} aria-hidden />
        </IconButton>
        <output className="min-w-10 text-center text-ui-sm text-qn-muted tabular-nums">{ZOOM_LEVELS[step]}%</output>
        <IconButton label={t('放大')} tooltip={false} title={t('放大')} disabled={step === ZOOM_LEVELS.length - 1}
          onClick={() => setStep((value) => Math.min(ZOOM_LEVELS.length - 1, value + 1))}>
          <Plus size={16} aria-hidden />
        </IconButton>
        <button type="button" className="qn-button-subtle h-8 whitespace-nowrap" onClick={() => reset(false)}>
          {t('适应窗口')}
        </button>
        {allowOriginalSize && (
          <button type="button" className="qn-button-subtle h-8 whitespace-nowrap"
            aria-pressed={originalSize && step === FIT_INDEX} onClick={() => reset(true)}>
            {t('原始尺寸')}
          </button>
        )}
      </div>
      {actions}
    </div>
  )

  const blankClick = (event: MouseEvent<HTMLElement>) => {
    if (event.target === event.currentTarget) onBlankClick?.()
  }

  return (
    <div className={cn('flex min-h-0 min-w-0 flex-1 flex-col', className)}>
      <div className="qn-scroll flex min-h-0 min-w-0 flex-1 overflow-auto overscroll-contain [container-type:size] focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-qn-outline-hover"
        tabIndex={0} aria-label={t('图片查看区域')} role="region" onClick={blankClick}>
        <div className="m-auto flex shrink-0 flex-col items-center gap-2" onClick={blankClick}>
          {/* CSS zoom 参与布局，放大后可以滚动到图片的四条边；适应模式给下方工具栏（32px + 8px 间距）留出高度。 */}
          <img ref={imageRef} src={src} alt={alt} loading="lazy" draggable={false}
            className={cn(
              'block h-auto w-auto shrink-0',
              originalSize ? 'max-h-none max-w-none' : 'max-h-[calc(100cqh-2.5rem)] max-w-[100cqw]',
              allowOriginalSize && (originalSize ? 'cursor-zoom-out' : 'cursor-zoom-in'),
            )}
            style={{ zoom: ZOOM_LEVELS[step]! / 100 }}
            onClick={allowOriginalSize ? () => reset(!originalSize) : undefined} />
          {toolbar}
        </div>
      </div>
    </div>
  )
}
