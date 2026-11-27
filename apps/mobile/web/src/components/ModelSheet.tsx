import { Check, ChevronDown, Zap } from 'lucide-react'
import { localizeModelDescription, t, translateMessage } from '@qn/codex-client'
import { useEffect, useMemo, useState } from 'react'
import { sessionKey } from '../agents'
import { EMPTY_PREFS, effortHint, effortLabel, pickModel, prefsFor, resolveSelection, triggerLabel, visibleModels, type ModelPrefs } from '../models'
import { useApp } from '../store'
import type { AgentKind } from '../types'
import { AgentQuota } from './RateLimitView'
import { Button, Dialog, Loading, LoadingIcon, Note } from './ui'
import { WorkspaceSearch } from './WorkspaceHome'

/**
 * 输入区的"模型 · 推理强度"入口 + 底部弹层。
 * 数据来自当前会话 Agent 的 model/list，快速档只对 Codex 显示。
 */
export function ModelPicker({ targetId, agent, open: controlledOpen, onOpenChange }: {
  targetId: string; agent: AgentKind; open?: boolean; onOpenChange?: (open: boolean) => void
}) {
  const key = sessionKey(targetId, agent)
  const opened = useApp((s) => s.sessions[key]?.opened === true)
  const list = useApp((s) => s.models[key])
  // 每个会话各自记模型与强度；草稿（没有选中会话）读写的是新会话默认。
  const threadId = useApp((s) => s.selectedThreadId)
  const table = useApp((s) => s.modelPrefs)
  const saved = useApp((s) => threadId ? s.sessions[key]?.state.threads[threadId]?.savedConfig : undefined)
  const prefs = useMemo(() => prefsFor(table, agent, key, threadId, list?.models, saved),
    [table, agent, key, threadId, list?.models, saved])
  const load = useApp((s) => s.loadModels)
  const setModelPrefs = useApp((s) => s.setModelPrefs)
  const setPrefs = (target: string, kind: AgentKind, next: ModelPrefs) => setModelPrefs(target, kind, next, threadId)
  const [ownOpen, setOwnOpen] = useState(false)
  const open = controlledOpen ?? ownOpen
  const setOpen = onOpenChange ?? setOwnOpen
  const [query, setQuery] = useState('')

  useEffect(() => {
    if (opened) void load(targetId, agent)
  }, [opened, load, targetId, agent])

  const models = list?.models ?? []
  const selection = useMemo(() => resolveSelection(models, prefs), [models, prefs])
  const options = useMemo(() => visibleModels(models, selection.model?.model, query), [models, selection.model?.model, query])

  if (!opened || (!open && models.length === 0 && !list?.loading && !list?.error)) return null
  const showFast = agent === 'codex' && selection.fastTier !== null
  const label = triggerLabel(selection) || t('模型')
  const close = () => {
    setOpen(false)
    setQuery('')
  }

  return (
    <div className="qn-composer-model">
      {/* 打开时补拉一次：首次列表为空（如 pi 刚启动）时，靠这里触发 store 的过期重取。 */}
      <Button variant="ghost" onClick={() => { setOpen(true); void load(targetId, agent) }}
        aria-label={t('选择模型与推理强度')} aria-haspopup="dialog" aria-expanded={open} title={label}>
        {list?.loading && models.length === 0 && <LoadingIcon size={13} />}
        {selection.fast && <Zap size={13} className="shrink-0 text-qn-warn" aria-hidden />}
        {/* 窄屏只截断模型名，推理强度始终可见，避免截成「Opus 5.5 ·…」。 */}
        {selection.model ? (
          <>
            <span className="truncate">{translateMessage(selection.model.displayName)}</span>
            {effortLabel(selection.effort) && <span className="shrink-0">· {effortLabel(selection.effort)}</span>}
          </>
        ) : <span className="truncate">{label}</span>}
        <ChevronDown size={14} className="shrink-0" aria-hidden />
      </Button>
      {open && (
        <Dialog title={t('模型与推理强度')} onClose={close}>
          {list?.error && <Note tone="error" message={list.error} actionLabel={t('重试')} onAction={() => void load(targetId, agent, true)} />}
          {(models.length > 1 || query !== '') && (
            <div className="mb-2"><WorkspaceSearch label={t('搜索模型')} query={query} onChange={setQuery} /></div>
          )}
          {list?.loading && models.length === 0 && <Loading text={t('正在加载模型…')} />}
          {!list?.loading && !list?.error && options.length === 0 && (
            <p className="py-3 text-center text-sm text-qn-muted">{query.trim() ? t('没有匹配的模型') : t('暂无可选模型')}</p>
          )}
          <div className="mb-3 space-y-2" role="listbox" aria-label={t('模型')}>
            {options.map((model) => {
              const selected = model.model === selection.model?.model
              return (
                <button
                  key={model.id}
                  type="button"
                  role="option"
                  aria-selected={selected}
                  className={`qn-row qn-option rounded-xl border px-3 py-2.5 ${selected ? 'border-qn-outline-hover bg-qn-accent/10' : 'border-qn-border'}`}
                  onClick={() => setPrefs(targetId, agent, pickModel(models, prefs, model.model))}
                >
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-[15px] font-medium">{translateMessage(model.displayName)}</span>
                    {model.description && (
                      <span className="mt-0.5 block whitespace-normal text-xs leading-[18px] text-qn-muted [overflow-wrap:anywhere]">
                        {localizeModelDescription(model.description)}
                      </span>
                    )}
                  </span>
                  {selected && <Check size={16} className="shrink-0 text-qn-accent" aria-hidden />}
                </button>
              )
            })}
          </div>

          {selection.model && selection.model.efforts.length > 0 && (
            <div className="mb-3">
              <div className="qn-label">{t('推理强度')}</div>
              <div className="qn-segment" role="radiogroup" aria-label={t('推理强度')}>
                {selection.model.efforts.map((effort) => {
                  const active = effort.value === selection.effort
                  return (
                    <button
                      key={effort.value}
                      type="button"
                      role="radio"
                      aria-checked={active}
                      onClick={() => setPrefs(targetId, agent, { ...prefs, effort: effort.value })}
                    >
                      {effortLabel(effort.value)}
                    </button>
                  )
                })}
              </div>
              {selection.effort && effortHint(selection.effort) && (
                <p className="qn-hint">{effortHint(selection.effort)}</p>
              )}
            </div>
          )}

          {showFast && (
            <div className="mb-3">
              <div className="qn-label">{t('速度')}</div>
              <div className="qn-segment" role="radiogroup" aria-label={t('速度')}>
                <button type="button" role="radio" aria-checked={!selection.fast}
                  onClick={() => setPrefs(targetId, agent, { ...prefs, fast: false })}>
                  {t('标准')}
                </button>
                <button type="button" role="radio" aria-checked={selection.fast}
                  onClick={() => setPrefs(targetId, agent, { ...prefs, fast: true })}>
                  <Zap size={14} className="text-qn-warn" aria-hidden /> {t('快速')}
                </button>
              </div>
              <p className="qn-hint">{t('快速档响应更快，额度消耗更多')}</p>
            </div>
          )}

          <AgentQuota targetId={targetId} agent={agent} />

          <div className="flex gap-2">
            {agent !== 'codex' && (prefs.model || prefs.effort) && (
              <Button className="flex-1" onClick={() => setPrefs(targetId, agent, EMPTY_PREFS)}>
                {t('跟随 Agent 默认')}
              </Button>
            )}
            <Button variant="primary" className="flex-1" onClick={close}>
              {t('完成')}
            </Button>
          </div>
        </Dialog>
      )}
    </div>
  )
}
