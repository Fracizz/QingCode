import type { TermInfo } from '@qn/protocol'
import { Plus, Terminal, X } from 'lucide-react'
import { lazy, Suspense, useEffect, useRef, useState } from 'react'
import { t, translateMessage } from '@qn/codex-client'
import { ResizeHandle } from '../../components/ResizeHandle'
import { EmptyState, ErrorNote, IconButton, Spinner } from '../../components/ui'
import { cn } from '../../lib/cn'
import { friendlyError } from '../../lib/errors'
import { useCodex } from '../../store/codex'
import { useTargets } from '../../store/targets'
import { serverCall } from '../workspace/serverCall'
import { useTerminalDock } from './dockState'
import { restoreTerminalTabs } from './terminalModel'

const TerminalView = lazy(() => import('./TerminalView'))
const DEFAULT_HEIGHT = 264

function TerminalTab({ visible, ...props }: { visible: boolean; ready: boolean; targetId: string; info: TermInfo }) {
  const [visited, setVisited] = useState(visible)
  useEffect(() => {
    if (visible) setVisited(true)
  }, [visible])
  if (!visible && !visited) return null
  return (
    <Suspense fallback={visible && <div className="p-3"><Spinner label={t('正在加载终端…')} /></div>}>
      <TerminalView visible={visible} {...props} />
    </Suspense>
  )
}

function TerminalPanel({ targetId, cwd, open }: { targetId: string; cwd: string; open: boolean }) {
  const ready = useTargets((state) => state.states[targetId]?.state === 'ready')
  const [state, setState] = useState<{ tabs: TermInfo[]; activeId: string | null }>({ tabs: [], activeId: null })
  const [loading, setLoading] = useState(ready)
  const [busy, setBusy] = useState(false)
  const [warning, setWarning] = useState<string | null>(null)
  const [reload, setReload] = useState(0)
  const mounted = useRef(false)

  useEffect(() => {
    mounted.current = true
    return () => { mounted.current = false }
  }, [])

  useEffect(() => {
    if (!ready) return
    let current = true
    setLoading(true)
    setWarning(null)
    void serverCall(targetId, 'term.list', {}).then(({ terminals }) => {
      if (current) setState((previous) => restoreTerminalTabs(terminals, cwd, previous.activeId))
    }).catch((err: unknown) => {
      if (current) setWarning(translateMessage(friendlyError(err, t('读取终端列表失败'))))
    }).finally(() => {
      if (current) setLoading(false)
    })
    return () => { current = false }
  }, [targetId, cwd, ready, reload])

  const create = async () => {
    setBusy(true)
    setWarning(null)
    try {
      const info = await serverCall(targetId, 'term.open', { cwd })
      // 标签加载前输出由 daemon 缓冲，避免快速切换项目时遗留订阅。
      void serverCall(targetId, 'term.detach', { termId: info.termId }).catch(() => {})
      if (mounted.current) {
        setState((previous) => ({
          tabs: [...previous.tabs.filter((tab) => tab.termId !== info.termId), info],
          activeId: info.termId,
        }))
      }
    } catch (err) {
      if (mounted.current) setWarning(translateMessage(friendlyError(err, t('新建终端失败'))))
    } finally {
      if (mounted.current) setBusy(false)
    }
  }

  const close = async (termId: string) => {
    setBusy(true)
    setWarning(null)
    try {
      await serverCall(targetId, 'term.close', { termId })
      if (mounted.current) {
        setState((previous) => restoreTerminalTabs(
          previous.tabs.filter((tab) => tab.termId !== termId), cwd, previous.activeId,
        ))
      }
    } catch (err) {
      if (mounted.current) setWarning(translateMessage(friendlyError(err, t('关闭终端失败'))))
    } finally {
      if (mounted.current) setBusy(false)
    }
  }

  const disabled = !ready || busy || loading

  return (
    <>
      <div className="flex h-9 shrink-0 items-center gap-1 border-b border-qn-border px-2">
        <Terminal size={14} className="ml-1 shrink-0 text-qn-muted" aria-hidden />
        <span className="mr-1 shrink-0 text-ui-sm text-qn-muted">{t('终端')}</span>
        <div className="qn-scroll flex min-w-0 flex-1 items-center gap-1 overflow-x-auto">
          {state.tabs.map((info, index) => {
            const name = info.shell.split(/[\\/]/).at(-1) || t('终端')
            const label = `${name} ${index + 1}`
            const active = info.termId === state.activeId
            return (
              <div key={info.termId} className={cn('flex shrink-0 items-center rounded-md px-0.5', active ? 'bg-qn-active text-qn-text' : 'text-qn-muted')}>
                <button
                  type="button"
                  className="max-w-32 truncate rounded px-1.5 py-1 text-ui-sm hover:text-qn-text focus-visible:outline-qn-accent"
                  aria-pressed={active}
                  title={label}
                  onClick={() => setState((previous) => ({ ...previous, activeId: info.termId }))}
                >
                  {label}
                </button>
                <IconButton size="sm" label={t('关闭 {name}', { name: label })} disabled={disabled} onClick={() => void close(info.termId)}>
                  <X size={12} />
                </IconButton>
              </div>
            )
          })}
        </div>
        <IconButton size="sm" label={t('新建终端')} disabled={disabled} onClick={() => void create()}>
          <Plus size={15} />
        </IconButton>
        <IconButton size="sm" label={t('收起终端面板')} onClick={useTerminalDock.getState().close}>
          <X size={14} />
        </IconButton>
      </div>
      {!ready && <div className="shrink-0 px-3 py-1 text-ui-sm text-qn-warn" role="status">{t('目标未连接')}</div>}
      {warning && (
        <div className="shrink-0 px-2 pt-2">
          <ErrorNote
            message={warning}
            onRetry={ready && !busy ? () => setReload((previous) => previous + 1) : undefined}
            onClose={() => setWarning(null)}
          />
        </div>
      )}
      <div className="relative min-h-0 flex-1">
        {ready && loading && !state.tabs.length && <div className="p-3"><Spinner label={t('正在读取终端…')} /></div>}
        {!state.tabs.length && !(ready && loading) && (
          <EmptyState>{ready ? t('点击新建终端，在当前项目中启动 shell。') : t('连接目标后可打开终端。')}</EmptyState>
        )}
        {state.tabs.map((info) => (
          <TerminalTab key={`${info.termId}:${info.startedAt}`} targetId={targetId} info={info} ready={ready} visible={open && info.termId === state.activeId} />
        ))}
      </div>
    </>
  )
}

export function TerminalDock() {
  const open = useTerminalDock((state) => state.open)
  const targetId = useCodex((state) => state.currentTargetId)
  const cwd = useCodex((state) => state.currentCwd)
  const scope = JSON.stringify([targetId, cwd])
  const [visitedScope, setVisitedScope] = useState<string | null>(null)
  const [height, setHeight] = useState(DEFAULT_HEIGHT)

  useEffect(() => {
    if (open) setVisitedScope(scope)
  }, [open, scope])
  if (!open && visitedScope !== scope) return null

  return (
    <section
      aria-label={t('终端面板')}
      className={cn('relative flex max-h-[min(65%,calc(100%-24rem))] shrink-0 flex-col border-t border-qn-border bg-qn-bg', !open && 'hidden')}
      style={{ height }}
    >
      <ResizeHandle
        orientation="horizontal"
        direction={-1}
        value={height}
        onChange={setHeight}
        onReset={() => setHeight(DEFAULT_HEIGHT)}
        min={152}
        max={640}
        label={t('调整终端面板高度')}
        className="absolute inset-x-0 -top-1 z-10"
      />
      {targetId && cwd ? (
        <TerminalPanel key={scope} targetId={targetId} cwd={cwd} open={open} />
      ) : (
        <>
          <div className="flex h-9 shrink-0 items-center justify-between border-b border-qn-border px-3 text-ui-sm text-qn-muted">
            <span>{t('终端')}</span>
            <IconButton size="sm" label={t('收起终端面板')} onClick={useTerminalDock.getState().close}><X size={14} /></IconButton>
          </div>
          <EmptyState>{t('先在左侧选择一个项目。')}</EmptyState>
        </>
      )}
    </section>
  )
}
