import { t, translateMessage } from '@qn/codex-client'
import { X } from 'lucide-react'
import { useEffect } from 'react'
import { useApp } from '../store'
import { dismissToast, toast, useToasts } from '../toast'

/**
 * 全局悬浮提示：固定在顶部安全区下方，按时自动关闭，点关闭按钮可提前关掉。
 * 同时接管 store 里的 notice / error 的展示，各页面不再各自内嵌提示条。
 */
export function Toaster() {
  const items = useToasts((s) => s.items)
  const notice = useApp((s) => s.notice)
  const error = useApp((s) => s.error)

  useEffect(() => {
    if (!notice) return
    toast(notice, { tone: 'warn' })
    useApp.getState().clearNotice()
  }, [notice])

  // error 还被目标页等用来判断"读取失败"，这里只负责弹出，不清空状态。
  useEffect(() => {
    if (error) toast(error, { tone: 'error' })
  }, [error])

  if (!items.length) return null
  return (
    <div className="qn-toaster" aria-live="polite">
      {items.map((item) => (
        <div key={item.id} className="qn-toast" data-tone={item.tone} role={item.tone === 'error' ? 'alert' : 'status'}>
          {/* 提示可能来自电脑端、daemon 或原生层，统一在展示时翻译。 */}
          <span className="min-w-0 flex-1 whitespace-pre-wrap break-words">{translateMessage(item.message)}</span>
          {item.actionLabel && item.onAction && (
            <button type="button" className="qn-note-action" onClick={() => { item.onAction?.(); dismissToast(item.id) }}>
              {translateMessage(item.actionLabel)}
            </button>
          )}
          <button type="button" className="qn-note-close" aria-label={t('关闭提示')} onClick={() => dismissToast(item.id)}>
            <X size={15} />
          </button>
        </div>
      ))}
    </div>
  )
}
