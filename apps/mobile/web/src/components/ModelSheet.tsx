import { useEffect, useMemo, useState } from 'react'
import { sessionKey } from '../agents'
import { EMPTY_PREFS, effortLabel, pickModel, resolveSelection, triggerLabel, visibleModels } from '../models'
import { useApp } from '../store'
import type { AgentKind } from '../types'
import { Button, Dialog } from './ui'

/**
 * 输入框上方的"模型 · 推理强度"入口 + 底部弹层（参考桌面 ModelPicker）。
 * 数据来自当前会话 Agent 的 model/list，列表为空时整块不显示；快速档只对 Codex 显示。
 */
export function ModelPicker({ targetId, agent }: { targetId: string; agent: AgentKind }) {
  const key = sessionKey(targetId, agent)
  const opened = useApp((s) => s.sessions[key]?.opened === true)
  const list = useApp((s) => s.models[key])
  const prefs = useApp((s) => s.modelPrefs[key] ?? EMPTY_PREFS)
  const load = useApp((s) => s.loadModels)
  const setPrefs = useApp((s) => s.setModelPrefs)
  const [open, setOpen] = useState(false)

  useEffect(() => {
    if (opened) void load(targetId, agent)
  }, [opened, load, targetId, agent])

  const models = list?.models ?? []
  const selection = useMemo(() => resolveSelection(models, prefs), [models, prefs])
  const options = useMemo(() => visibleModels(models, selection.model?.model), [models, selection.model?.model])

  if (!opened || models.length === 0) return null
  const showFast = agent === 'codex' && selection.fastTier !== null

  return (
    <>
      <button type="button" className="qn-chip" onClick={() => setOpen(true)} aria-label="选择模型与推理强度">
        {selection.fast && <span className="text-qn-warn">⚡</span>}
        <span className="truncate">{triggerLabel(selection) || '模型'}</span>
        <span aria-hidden>▾</span>
      </button>
      {open && (
        <Dialog title="模型与推理强度" onClose={() => setOpen(false)}>
          {list?.error && <p className="mb-2 text-xs text-qn-danger">{list.error}</p>}
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
                  {selected && <span className="text-qn-accent">✓</span>}
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
                ⚡ 快速（响应更快，额度消耗更多）
              </button>
            </div>
          )}

          <div className="flex gap-2">
            {agent !== 'codex' && (prefs.model || prefs.effort) && (
              <Button className="flex-1" onClick={() => setPrefs(targetId, agent, EMPTY_PREFS)}>
                跟随 Agent 默认
              </Button>
            )}
            <Button variant="primary" className="flex-1" onClick={() => setOpen(false)}>
              完成
            </Button>
          </div>
        </Dialog>
      )}
    </>
  )
}
