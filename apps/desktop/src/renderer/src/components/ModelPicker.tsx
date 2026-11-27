import { useEffect, useMemo, useRef, useState } from 'react'
import { Check, ChevronDown, Zap } from 'lucide-react'
import { t, translateMessage } from '@qn/codex-client'
import type { AgentKind } from '../../../shared/backendApi'
import { sessionKey } from '../lib/agents'
import { cn } from '../lib/cn'
import {
  contextUsage,
  effortHint,
  effortLabel,
  filterModels,
  formatTokens,
  localizeModelDescription,
  resolveSelection,
  triggerLabel,
} from '../lib/models'
import { useCodex } from '../store/codex'
import { prefsFor, useModels } from '../store/models'
import { ListOption } from './ListOption'
import { LoadingIcon } from './LoadingIcon'
import { ProgressRing } from './ProgressRing'
import { PopoverContent, PopoverRoot, PopoverTrigger, Tip } from './primitives'
import { SearchField } from './SearchField'
import { EmptyState, ErrorNote, Spinner } from './ui'

const triggerClass = 'inline-flex h-8 max-w-[16rem] items-center gap-1 rounded-lg px-2 text-ui text-qn-muted outline-none hover:bg-qn-hover hover:text-qn-text focus-visible:ring-1 focus-visible:ring-qn-accent data-[state=open]:bg-qn-hover data-[state=open]:text-qn-text'

/**
 * 输入框里的模型选择器（参考 Codex）：搜索模型 → 选模型 → 推理强度分段 → 速度（Fast）开关。
 * 选择按 agent 记在本机，发送时作为 turn/start 的 model / effort / serviceTier 覆盖项。
 * pi 需要先有运行中的会话才能读到模型，冷启动时由用户主动开启。
 */
export function ModelPicker({ targetId, agent, threadId, piDraft }: {
  targetId: string
  agent: AgentKind
  threadId: string | null
  piDraft?: { start: () => void; starting: boolean; disabled: boolean }
}) {
  const key = sessionKey(targetId, agent)
  const session = useCodex((s) => s.sessions[key])
  const list = useModels((s) => s.lists[key])
  // 每个会话各自记模型与强度；草稿（threadId 为 null）读写的是新会话默认。
  const prefs = useModels((s) => prefsFor(s, targetId, agent, threadId))
  const load = useModels((s) => s.load)
  const setPrefs = useModels((s) => s.setPrefs)
  const scope = { targetId, threadId }
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const searchRef = useRef<HTMLInputElement>(null)

  const savedConfig = threadId ? session?.state?.threads[threadId]?.savedConfig : undefined
  const seedFromHistory = useModels((s) => s.seedFromHistory)
  // 打开历史会话后，本机没记录就沿用该会话上次用的模型与强度，而不是最近一次在别处的选择。
  // 模型列表就绪后才能把历史里的模型对应到选项（Claude 历史记的是完整模型 ID），列表变化时重试。
  const listedModels = list?.models
  useEffect(() => {
    if (threadId) seedFromHistory(targetId, agent, threadId, savedConfig)
  }, [seedFromHistory, targetId, agent, threadId, savedConfig, listedModels])

  const rpc = session?.opened ? session.rpc : undefined
  const directory = session?.openedConfig?.directory
  const hasClaudeTurn = agent === 'claude' && threadId !== null &&
    session?.state.threads[threadId]?.turns?.some((turn) => turn.outcome !== undefined) === true
  useEffect(() => {
    if (rpc) void load(targetId, agent, rpc, agent === 'claude' || (agent === 'pi' && threadId !== null))
  }, [rpc, threadId, directory, hasClaudeTurn, load, targetId, agent])

  const models = list?.models ?? []
  const selection = useMemo(() => resolveSelection(models, prefs), [models, prefs])
  const visible = useMemo(() => filterModels(models, query), [models, query])

  const empty = models.length === 0 && !list?.loading && !list?.error
  if (piDraft && (piDraft.starting || empty)) {
    return (
      <button
        type="button"
        className={cn(triggerClass, 'disabled:text-qn-dim')}
        title={t('启动 pi 会话后可选择模型')}
        disabled={piDraft.disabled}
        onClick={piDraft.start}
      >
        {piDraft.starting ? <><LoadingIcon size={13} /> {t('正在启动 pi…')}</> : t('启动 pi 以选择模型')}
      </button>
    )
  }
  if (!rpc || (empty && agent !== 'pi')) return null

  const pick = (model: string) => {
    const option = models.find((item) => item.model === model)
    // 换模型时强度若不被新模型支持，交给 resolveSelection 回落到默认，这里不清空偏好里的强度。
    setPrefs(agent, { model, ...(option && prefs.effort && !option.efforts.some((e) => e.value === prefs.effort) ? { effort: null } : {}) }, scope)
  }

  return (
    <PopoverRoot
      open={open}
      onOpenChange={(value) => {
        setOpen(value)
        if (!value) setQuery('')
      }}
    >
      <PopoverTrigger asChild>
        <button
          type="button"
          className={triggerClass}
          aria-label={t('选择模型与推理强度')}
        >
          {list?.loading && models.length === 0 ? (
            <LoadingIcon size={13} />
          ) : (
            selection.fast && <Zap size={13} className="shrink-0 text-qn-warn" />
          )}
          <span className="truncate">{triggerLabel(selection) || t('模型')}</span>
          <ChevronDown size={14} className="shrink-0" />
        </button>
      </PopoverTrigger>
      <PopoverContent
        side="top"
        align="end"
        className="w-[min(420px,calc(100vw-32px))] overflow-hidden p-0"
        onOpenAutoFocus={(event) => {
          event.preventDefault()
          searchRef.current?.focus()
        }}
      >
        <SearchField
          ref={searchRef}
          label={t('搜索模型')}
          className="gap-2.5 border-b border-qn-border px-3.5 py-3"
          inputClassName="text-ui-md"
          placeholder={t('搜索模型…')}
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && visible[0]) {
              event.preventDefault()
              pick(visible[0].model)
              setQuery('')
            }
          }}
        />

        <div className="qn-scroll max-h-[min(320px,45vh)] space-y-1 overflow-y-auto p-1.5" role="listbox" aria-label={t('模型')}>
          <ErrorNote
            message={list?.error ?? null}
            variant="compact"
            onRetry={() => void load(targetId, agent, rpc, true)}
          />
          {list?.loading && models.length === 0 && (
            <div className="px-2.5 py-3"><Spinner label={t('正在加载模型…')} /></div>
          )}
          {!list?.loading && visible.length === 0 && models.length > 0 && (
            <EmptyState className="px-2.5 py-3 leading-5">{t('没有匹配的模型')}</EmptyState>
          )}
          {agent === 'pi' && empty && (
            <EmptyState className="px-2.5 py-3 leading-5">
              <p>{t('暂无可用模型。请在目标机器的 pi 中配置模型后重试。')}</p>
              <button type="button" className={triggerClass} onClick={() => void load(targetId, agent, rpc, true)}>
                {t('重新加载')}
              </button>
            </EmptyState>
          )}
          {visible.map((model) => {
            const selected = model.model === selection.model?.model
            return (
              <ListOption
                key={model.id}
                selected={selected}
                className="px-3 py-2.5"
                onClick={() => pick(model.model)}
              >
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-ui-md font-medium text-qn-text">{translateMessage(model.displayName)}</span>
                  {model.description && (
                    <span className="mt-0.5 line-clamp-2 block text-ui leading-5 text-qn-muted">
                      {localizeModelDescription(model.description)}
                    </span>
                  )}
                </span>
                {selected && <Check size={16} className="shrink-0 text-qn-text" />}
              </ListOption>
            )
          })}
        </div>

        {selection.model && (selection.model.efforts.length > 0 || selection.fastTier) && (
          <div className="space-y-2 border-t border-qn-border px-3.5 py-3">
            {selection.model.efforts.length > 0 && (
              <div className="flex items-center justify-between gap-3">
                <span className="shrink-0 text-ui text-qn-muted">{t('推理强度')}</span>
                <div className="flex flex-wrap justify-end gap-1" role="radiogroup" aria-label={t('推理强度')}>
                  {selection.model.efforts.map((effort) => {
                    const active = effort.value === selection.effort
                    const button = (
                      <button
                        key={effort.value}
                        type="button"
                        role="radio"
                        aria-checked={active}
                        className={cn(
                          'h-8 rounded-lg px-2.5 text-ui outline-none focus-visible:ring-1 focus-visible:ring-qn-accent',
                          active ? 'bg-qn-active font-medium text-qn-text' : 'text-qn-muted hover:bg-qn-hover hover:text-qn-text',
                        )}
                        onClick={() => setPrefs(agent, { effort: effort.value }, scope)}
                      >
                        {effortLabel(effort.value)}
                      </button>
                    )
                    const hint = effortHint(effort.value, effort.description)
                    return hint ? (
                      <Tip key={effort.value} label={hint}>
                        {button}
                      </Tip>
                    ) : (
                      button
                    )
                  })}
                </div>
              </div>
            )}
            {selection.fastTier && (
              <div className="flex items-center justify-between gap-3">
                <span className="shrink-0 text-ui text-qn-muted">{t('速度')}</span>
                <Tip label={t('优先处理请求，响应更快，额度消耗更多')}>
                <button
                  type="button"
                  aria-pressed={selection.fast}
                  className={cn(
                    'inline-flex h-8 items-center gap-1.5 rounded-lg border px-3 text-ui outline-none focus-visible:ring-1 focus-visible:ring-qn-accent',
                    selection.fast
                      ? 'border-qn-warn/50 bg-qn-warn/10 text-qn-warn'
                      : 'border-qn-border-strong text-qn-muted hover:bg-qn-hover hover:text-qn-text',
                  )}
                  onClick={() => setPrefs(agent, { fast: !selection.fast }, scope)}
                >
                  <Zap size={14} /> {t('快速')}
                </button>
                </Tip>
              </div>
            )}
          </div>
        )}
      </PopoverContent>
    </PopoverRoot>
  )
}

/** 上下文窗口占用环（参考 Codex 输入框右下角）；拿不到窗口大小时不显示。 */
export function ContextRing({ tokenUsage }: { tokenUsage: unknown }) {
  const usage = contextUsage(tokenUsage)
  if (!usage) return null
  const tone = usage.percent >= 90 ? 'var(--color-qn-danger)' : usage.percent >= 75 ? 'var(--color-qn-warn)' : 'var(--color-qn-muted)'
  return (
    <Tip label={t('上下文已用 {percent}% · {used} / {window} tokens', {
      percent: usage.percent,
      used: formatTokens(usage.used),
      window: formatTokens(usage.window),
    })}>
      <span className="inline-flex h-8 w-8 items-center justify-center" role="img" aria-label={t('上下文已用 {percent}%', { percent: usage.percent })}>
        <ProgressRing percent={usage.percent} size={14} color={tone} />
      </span>
    </Tip>
  )
}
