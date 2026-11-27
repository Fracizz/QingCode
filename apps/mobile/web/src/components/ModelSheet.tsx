import { Check, ChevronDown, Zap } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import { sessionKey } from '../agents'
import { EMPTY_PREFS, effortLabel, pickModel, resolveSelection, triggerLabel, visibleModels } from '../models'
import { useApp } from '../store'
import type { AgentKind } from '../types'
import { Button, Dialog, Loading, LoadingIcon, Note } from './ui'
import { WorkspaceSearch } from './WorkspaceHome'

/**
 * 输入框上方的"模型 · 推理强度"入口 + 底部弹层（参考桌面 ModelPicker）。
 * 数据来自当前会话 Agent 的 model/list，快速档只对 Codex 显示。
 */
export function ModelPicker({ targetId, agent }: { targetId: string; agent: AgentKind }) {
  const key = sessionKey(targetId, agent)
  const opened = useApp((s) => s.sessions[key]?.opened === true)
  const list = useApp((s) => s.models[key])
  const prefs = useApp((s) => s.modelPrefs[key] ?? EMPTY_PREFS)
  const load = useApp((s) => s.loadModels)
  const setPrefs = useApp((s) => s.setModelPrefs)
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')

  useEffect(() => {
    if (opened) void load(targetId, agent)
  }, [opened, load, targetId, agent])

  const models = list?.models ?? []
  const selection = useMemo(() => resolveSelection(models, prefs), [models, prefs])
  const options = useMemo(() => visibleModels(models, selection.model?.model, query), [models, selection.model?.model, query])

  if (!opened || (!open && models.length === 0 && !list?.loading && !list?.error)) return null
  const showFast = agent === 'codex' && selection.fastTier !== null
  const close = () => {
    setOpen(false)
    setQuery('')
  }

  return (
    <div className="qn-composer-model">
      {/* 打开时补拉一次：首次列表为空（如 pi 刚启动）时，靠这里触发 store 的过期重取。 */}
      <button type="button" className="qn-chip" onClick={() => { setOpen(true); void load(targetId, agent) }} aria-label="选择模型与推理强度">
        {list?.loading && models.length === 0 && <LoadingIcon size={13} />}
        {selection.fast && <Zap size={13} className="shrink-0 text-qn-warn" aria-hidden />}
        <span className="truncate">{triggerLabel(selection) || '模型'}</span>
        <ChevronDown size={14} className="shrink-0" aria-hidden />
      </button>
      {open && (
        <Dialog title="模型与推理强度" onClose={close}>
          {list?.error && <Note tone="error" message={list.error} actionLabel="重试" onAction={() => void load(targetId, agent, true)} />}
          {(models.length > 1 || query !== '') && (
            <div className="mb-2"><WorkspaceSearch label="搜索模型" query={query} onChange={setQuery} /></div>
          )}
          {list?.loading && models.length === 0 && <Loading text="正在加载模型…" />}
          {!list?.loading && !list?.error && options.length === 0 && (
            <p className="py-3 text-center text-sm text-qn-muted">{query.trim() ? '没有匹配的模型' : '暂无可选模型'}</p>
          )}
          <div className="mb-3 space-y-2" role="listbox" aria-label="模型">
            {options.map((model) => {
              const selected = model.model === selection.model?.model
              return (
                <button
                  key={model.id}
                  type="button"
                  role="option"
                  aria-selected={selected}
                  className={`qn-row rounded-xl border px-3 py-2 ${selected ? 'border-qn-accent bg-qn-accent/10' : 'border-qn-border'}`}
                  onClick={() => setPrefs(targetId, agent, pickModel(models, prefs, model.model))}
                >
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm font-medium">{model.displayName}</span>
                    {model.description && (
                      <span className="block text-[11px] leading-4 text-qn-muted">{model.description}</span>
                    )}
                  </span>
                  {selected && <Check size={16} className="shrink-0 text-qn-accent" aria-hidden />}
                </button>
              )
            })}
          </div>

          {selection.model && selection.model.efforts.length > 0 && (
            <div className="mb-3">
              <div className="qn-label">推理强度</div>
              <div className="flex flex-wrap gap-2" role="radiogroup" aria-label="推理强度">
                {selection.model.efforts.map((effort) => {
                  const active = effort.value === selection.effort
                  return (
                    <button
                      key={effort.value}
                      type="button"
                      role="radio"
                      aria-checked={active}
                      className={`qn-chip ${active ? 'qn-chip-active' : ''}`}
                      onClick={() => setPrefs(targetId, agent, { ...prefs, effort: effort.value })}
                    >
                      {effortLabel(effort.value)}
                    </button>
                  )
                })}
              </div>
            </div>
          )}

          {showFast && (
            <div className="mb-3">
              <div className="qn-label">速度</div>
              <button
                type="button"
                aria-pressed={selection.fast}
                className={`qn-chip ${selection.fast ? 'qn-chip-active' : ''}`}
                onClick={() => setPrefs(targetId, agent, { ...prefs, fast: !selection.fast })}
              >
                <Zap size={14} className="inline align-[-2px] text-qn-warn" aria-hidden /> 快速（响应更快，额度消耗更多）
              </button>
            </div>
          )}

          <div className="flex gap-2">
            {agent !== 'codex' && (prefs.model || prefs.effort) && (
              <Button className="flex-1" onClick={() => setPrefs(targetId, agent, EMPTY_PREFS)}>
                跟随 Agent 默认
              </Button>
            )}
            <Button variant="primary" className="flex-1" onClick={close}>
              完成
            </Button>
          </div>
        </Dialog>
      )}
    </div>
  )
}
