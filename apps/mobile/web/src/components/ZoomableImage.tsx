import { t } from '@qn/codex-client'
import { Minus, Plus, Scan } from 'lucide-react'
import { useState, type ReactNode } from 'react'
import { Button, Loading } from './ui'

const ZOOM_LEVELS = [25, 50, 75, 100, 125, 150, 200, 300, 400]
const FIT_INDEX = ZOOM_LEVELS.indexOf(100)

export function ZoomableImage({ src, alt, error, onBlankClick }: {
  src: string
  alt: string
  error: ReactNode
  onBlankClick?: () => void
}) {
  const [status, setStatus] = useState<'loading' | 'ready' | 'failed'>('loading')
  const [step, setStep] = useState(FIT_INDEX)

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col">
      <div className="qn-scroll qn-image-stage"
        tabIndex={0} role="region" aria-label={t('图片查看区域')} onClick={(event) => {
          if (event.target === event.currentTarget) onBlankClick?.()
        }}>
        {/* 图片缩放参与布局，手机可直接滑动查看超出屏幕的部分。 */}
        <img src={src} alt={alt} draggable={false} decoding="async" hidden={status !== 'ready'}
          className="m-auto h-auto max-h-[100cqh] w-auto max-w-[100cqw] shrink-0"
          style={{ zoom: ZOOM_LEVELS[step]! / 100 }} onLoad={() => setStatus('ready')} onError={() => setStatus('failed')} />
        {status === 'loading' && <div className="m-auto"><Loading text={t('正在加载图片…')} /></div>}
        {status === 'failed' && <div className="m-auto">{error}</div>}
      </div>
      {status === 'ready' && (
        <div role="group" aria-label={t('图片缩放')} className="qn-zoom-bar">
          <Button variant="ghost" aria-label={t('缩小')} className="size-11 p-0!" disabled={step === 0}
            onClick={() => setStep((value) => Math.max(0, value - 1))}>
            <Minus size={18} aria-hidden />
          </Button>
          <output className="min-w-10 text-center text-sm text-qn-muted tabular-nums">{ZOOM_LEVELS[step]}%</output>
          <Button variant="ghost" aria-label={t('放大')} className="size-11 p-0!" disabled={step === ZOOM_LEVELS.length - 1}
            onClick={() => setStep((value) => Math.min(ZOOM_LEVELS.length - 1, value + 1))}>
            <Plus size={18} aria-hidden />
          </Button>
          <Button variant="ghost" aria-label={t('适应窗口')} className="size-11 p-0!" onClick={() => setStep(FIT_INDEX)}>
            <Scan size={18} aria-hidden />
          </Button>
        </div>
      )}
    </div>
  )
}
