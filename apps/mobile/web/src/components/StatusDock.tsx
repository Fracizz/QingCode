import {
  planProgress, subagentStatusTone, t,
  type CodexRpcLike, type ItemView, type PlanView, type SubagentEntry, type ThreadView,
} from '@qn/codex-client'
import { Activity, ListChecks, Network, type LucideIcon } from 'lucide-react'
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode, type RefObject } from 'react'
import { BackgroundTaskList, useBackgroundTasks } from './BackgroundTasks'
import { PlanSteps } from './PlanPanel'
import { SubagentDialog } from './SubagentDetails'
import { Dialog } from './ui'

export type DockSheet = 'subagents' | 'plan' | 'tasks'

export function planLabel(plan: PlanView): string {
  const { done, total } = planProgress(plan)
  return t('任务清单 {done}/{total}', { done, total })
}

/** 松手后保留收起状态的时间，让惯性滚动走完再滑回。 */
const TUCK_RELEASE_MS = 700
/** 展开后无操作多久收回成单个图标。 */
export const DOCK_COLLAPSE_MS = 4000

/** 手指滑动消息时让胶囊让位；只认触摸，流式输出的自动滚动不会让它来回躲。 */
function useTuckedWhileScrolling(ref: RefObject<HTMLElement | null>, onScroll: () => void): boolean {
  const [tucked, setTucked] = useState(false)
  useEffect(() => {
    const node = ref.current
    if (!node) return
    let timer: ReturnType<typeof setTimeout> | undefined
    const move = () => { clearTimeout(timer); setTucked(true); onScroll() }
    const release = () => { clearTimeout(timer); timer = setTimeout(() => setTucked(false), TUCK_RELEASE_MS) }
    node.addEventListener('touchmove', move, { passive: true })
    node.addEventListener('touchend', release, { passive: true })
    node.addEventListener('touchcancel', release, { passive: true })
    return () => {
      clearTimeout(timer)
      node.removeEventListener('touchmove', move)
      node.removeEventListener('touchend', release)
      node.removeEventListener('touchcancel', release)
    }
  }, [ref, onScroll])
  return tucked
}

type DockEntry = {
  sheet: DockSheet
  icon: LucideIcon
  label: string
  caption: string | number
  tone: 'accent' | 'warn' | 'danger' | 'plain'
}

const urgent = (entry: DockEntry) => entry.tone === 'warn' || entry.tone === 'danger'

function DockButton({ entry, collapsed = false, onClick }: { entry: DockEntry; collapsed?: boolean; onClick: () => void }) {
  const { icon: Icon, caption, tone } = entry
  // 收起时只露一个代表图标，点一下先展开，避免误入某一项详情。
  const label = collapsed ? t('会话状态') : entry.label
  return (
    <button type="button" className="qn-status-dock-item" data-tone={tone} aria-label={label} title={label}
      aria-haspopup={collapsed ? undefined : 'dialog'} aria-expanded={collapsed ? false : undefined} onClick={onClick}>
      <Icon size={19} strokeWidth={1.75} aria-hidden />
      <span aria-hidden>{caption}</span>
    </button>
  )
}

/**
 * 对话右上角的状态胶囊：子代理、任务清单、后台任务只在需要关注时滑出。有新情况时展开几秒，
 * 之后或滑动消息时收成单个图标；只有一项时图标直达详情，没有内容时整体收回。
 * 收回后仍可从顶栏“⋯”菜单打开，所以详情弹层由外部控制。须按会话 key 重建。
 */
export function StatusDock({ sheet, onSheetChange, scrollRef, plan, running, subagents, threads, rpc, renderItem }: {
  sheet: DockSheet | null
  onSheetChange: (sheet: DockSheet | null) => void
  scrollRef: RefObject<HTMLElement | null>
  plan: PlanView | undefined
  running: boolean
  subagents: readonly SubagentEntry[]
  threads?: Readonly<Record<string, ThreadView>>
  rpc: CodexRpcLike | null
  renderItem: (item: ItemView, showStreamingDots: boolean) => ReactNode
}) {
  const { tasks, ready, stopping, stop } = useBackgroundTasks()
  const [expanded, setExpanded] = useState(false)
  const collapse = useCallback(() => setExpanded(false), [])
  const tucked = useTuckedWhileScrolling(scrollRef, collapse)

  // 历史记录里可能残留“已启动”，只认本轮运行中或子会话仍在跑的。
  const active = subagents.filter((entry) => {
    const tone = subagentStatusTone(entry.status)
    if (tone !== 'active' && tone !== 'warn') return false
    return running || (entry.threadId ? threads?.[entry.threadId]?.status === 'running' : false)
  })
  // 只提醒眼看着跑失败的子代理，打开旧会话时不为历史失败弹出。
  const watched = useRef(new Set<string>())
  for (const entry of active) watched.current.add(entry.key)
  const [seenFailures, setSeenFailures] = useState<ReadonlySet<string>>(new Set())
  const failed = subagents.filter((entry) => subagentStatusTone(entry.status) === 'danger'
    && watched.current.has(entry.key) && !seenFailures.has(entry.key))
  const failedKeys = failed.map((entry) => entry.key).join('\n')
  useEffect(() => {
    if (sheet === 'subagents' && failedKeys) setSeenFailures((seen) => new Set([...seen, ...failedKeys.split('\n')]))
  }, [sheet, failedKeys])

  // 运行中常驻；本轮结束仍有未完成步骤时，看过一次就收回。
  const progress = plan?.steps.length ? planProgress(plan) : null
  const planKey = plan && progress ? `${plan.turnId}:${progress.done}/${progress.total}` : ''
  const [seenPlan, setSeenPlan] = useState('')
  useEffect(() => {
    if (sheet === 'plan' && !running) setSeenPlan(planKey)
  }, [sheet, running, planKey])

  // 弹层里的内容没了（最后一个任务停掉、清单被清空）就一起收起。
  const emptied = (sheet === 'tasks' && tasks.length === 0) || (sheet === 'plan' && !progress)
  useEffect(() => {
    if (emptied) onSheetChange(null)
  }, [emptied, onSheetChange])

  const entries: DockEntry[] = []
  if (active.length || failed.length) {
    entries.push({ sheet: 'subagents', icon: Network, label: t('子代理'), caption: failed.length || active.length,
      tone: failed.length ? 'danger' : active.some((entry) => subagentStatusTone(entry.status) === 'warn') ? 'warn' : 'accent' })
  }
  if (progress && progress.done < progress.total && (running || seenPlan !== planKey)) {
    entries.push({ sheet: 'plan', icon: ListChecks, label: planLabel(plan!), caption: `${progress.done}/${progress.total}`,
      tone: running ? 'accent' : 'plain' })
  }
  if (tasks.length) {
    entries.push({ sheet: 'tasks', icon: Activity, label: t('后台任务（{count}）', { count: tasks.length }), caption: tasks.length, tone: 'accent' })
  }

  // 出现新的一类或新的告警时展开给用户看一眼；进度数字变化不打扰。
  const signals = entries.map((entry) => `${entry.sheet}${urgent(entry) ? '!' : ''}`).join()
  const knownSignals = useRef<string[]>([])
  useLayoutEffect(() => {
    const next = signals ? signals.split(',') : []
    if (next.some((signal) => !knownSignals.current.includes(signal))) setExpanded(true)
    knownSignals.current = next
  }, [signals])
  useEffect(() => {
    if (!expanded || sheet) return
    const timer = setTimeout(collapse, DOCK_COLLAPSE_MS)
    return () => clearTimeout(timer)
  }, [expanded, sheet, signals, collapse])

  // 收回动画期间继续显示最后一批图标，不让胶囊先变空再滑走。
  const last = useRef<DockEntry[]>([])
  if (entries.length) last.current = entries
  const shown = entries.length ? entries : last.current
  const collapsed = shown.length > 1 && !expanded
  const primary = shown.find(urgent) ?? shown[0]
  const close = () => onSheetChange(null)

  return (
    <>
      {primary && (
        <div className="qn-status-dock" role="group" aria-label={t('会话状态')} data-state={entries.length ? 'open' : 'closed'}
          data-collapsed={collapsed || undefined} data-tucked={tucked || undefined}>
          {collapsed
            ? <DockButton entry={primary} collapsed onClick={() => setExpanded(true)} />
            : shown.map((entry) => <DockButton key={entry.sheet} entry={entry} onClick={() => onSheetChange(entry.sheet)} />)}
        </div>
      )}
      {sheet === 'subagents' && (
        <SubagentDialog entries={subagents} threads={threads} rpc={rpc} renderItem={renderItem} onClose={close} />
      )}
      {sheet === 'plan' && plan && progress && (
        <Dialog title={planLabel(plan)} onClose={close}>
          <PlanSteps plan={plan} running={running} />
        </Dialog>
      )}
      {sheet === 'tasks' && tasks.length > 0 && (
        <Dialog title={t('后台任务（{count}）', { count: tasks.length })} onClose={close}>
          <BackgroundTaskList tasks={tasks} ready={ready} stopping={stopping} onStop={(id) => void stop(id)} />
        </Dialog>
      )}
    </>
  )
}
