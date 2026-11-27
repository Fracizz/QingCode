import { useEffect, useState } from 'react'
import type { WorkspaceMethods } from '@qn/protocol'
import type {
  AgentPrefs,
  SettingsAgentKind,
  Target,
} from '../../../../shared/backendApi'
import { RefreshIcon } from '../../components/LoadingIcon'
import { Badge, Checkbox, ErrorNote, Spinner } from '../../components/ui'
import { useTargets } from '../../store/targets'
import { friendlyError } from '../../lib/errors'
import { serverCall } from '../workspace/serverCall'
import {
  SETTINGS_AGENT_INFO,
  agentPrefs,
  type SettingsAgentInfo,
} from './settingsModel'
import { useSettings } from './settingsStore'
import { DeferredInput, FieldLabel, InfoBlock } from './fields'

type ProbeResult = WorkspaceMethods['agent.probe']['result']
type ProbeState = { busy: boolean; result?: ProbeResult; error?: string }

function targetLabel(target: Target): string {
  if (target.kind === 'local') return '本机'
  if (target.kind === 'ssh') return `${target.name} · ${target.username}@${target.host}:${target.port}`
  return `${target.name} · ${target.host}:${target.port}`
}

function AgentRow({
  targetId,
  info,
  prefs,
  connected,
  onPatch,
}: {
  targetId: string
  info: SettingsAgentInfo
  prefs: AgentPrefs
  connected: boolean
  onPatch: (prefs: Partial<AgentPrefs>) => void
}) {
  const [pathDraft, setPathDraft] = useState(prefs.path ?? '')
  const [configDraft, setConfigDraft] = useState(prefs.configDir ?? '')
  const [probe, setProbe] = useState<ProbeState>({ busy: false })

  useEffect(() => setPathDraft(prefs.path ?? ''), [prefs.path])
  useEffect(() => setConfigDraft(prefs.configDir ?? ''), [prefs.configDir])

  const detect = async () => {
    setProbe({ busy: true })
    try {
      const path = pathDraft.trim()
      const result = await serverCall(targetId, 'agent.probe', {
        agent: info.id,
        ...(path ? { path } : {}),
      })
      setProbe({ busy: false, result })
    } catch (err) {
      setProbe({ busy: false, error: friendlyError(err, '检测失败') })
    }
  }

  return (
    <div className="rounded-xl border border-qn-border bg-qn-fg/[0.02] p-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <span className="text-ui font-medium text-qn-text">{info.label}</span>
          <Badge tone={prefs.enabled ? 'ok' : 'muted'}>{prefs.enabled ? '已启用' : '已停用'}</Badge>
        </div>
        <Checkbox checked={prefs.enabled} onChange={(value) => onPatch({ enabled: value })}>
          在新建会话里显示
        </Checkbox>
      </div>

      <div className="mt-3 grid gap-3 sm:grid-cols-2">
        <div>
          <FieldLabel>可执行文件路径（留空自动解析）</FieldLabel>
          <DeferredInput
            ariaLabel={`${info.label} 可执行文件路径`}
            value={pathDraft}
            placeholder="留空 = PATH / 常见安装目录"
            onCommit={(value) => {
              setPathDraft(value)
              onPatch({ path: value.trim() })
            }}
          />
        </div>
        {info.configEnv && (
          <div>
            <FieldLabel>{info.configEnv}</FieldLabel>
            <DeferredInput
              ariaLabel={`${info.label} ${info.configEnv}`}
              value={configDraft}
              placeholder="留空 = 使用官方默认位置"
              onCommit={(value) => {
                setConfigDraft(value)
                onPatch({ configDir: value.trim() })
              }}
            />
          </div>
        )}
      </div>

      <div className="mt-3 flex flex-wrap items-center gap-2">
        <button
          type="button"
          className="qn-button-subtle flex items-center gap-1.5 px-2.5 py-1 text-ui-sm"
          disabled={!connected || probe.busy}
          onClick={() => void detect()}
        >
          <RefreshIcon size={13} loading={probe.busy} />
          检测
        </button>
        {probe.busy && <Spinner label="正在运行 --version…" />}
        {!probe.busy && probe.result?.found && (
          <span className="min-w-0 break-all text-ui-sm text-qn-ok">
            已找到 {probe.result.version ? `· ${probe.result.version}` : '· 未返回版本号'} · {probe.result.path}
          </span>
        )}
        {!probe.busy && probe.result && !probe.result.found && (
          <span className="min-w-0 text-ui-sm text-qn-danger">
            未找到：{probe.result.error ?? '未安装或路径不正确'}
          </span>
        )}
        {!probe.busy && !probe.result && !connected && (
          <span className="text-ui-sm text-qn-dim">连接后检测</span>
        )}
      </div>
      {probe.error && <ErrorNote message={probe.error} onClose={() => setProbe({ busy: false })} />}

      {info.id === 'pi' && (
        <p className="mt-2 text-ui-sm text-qn-warn">pi 不经审批直接执行工具。</p>
      )}
      {info.configEnv && (
        <p className="mt-2 text-ui-sm leading-5 text-qn-dim">
          只保存 {info.configEnv} 路径字符串，不读取其中内容，也不提供自动切换 / 轮换。
        </p>
      )}
    </div>
  )
}

export function AgentSection({ visible }: { visible: (itemId: string) => boolean }) {
  const settings = useSettings((state) => state.settings)
  const update = useSettings((state) => state.update)
  const targets = useTargets((state) => state.targets)
  const states = useTargets((state) => state.states)
  const loaded = useTargets((state) => state.loaded)
  const load = useTargets((state) => state.load)

  useEffect(() => {
    if (!loaded) void load()
  }, [loaded, load])

  const patchAgent = (targetId: string, agent: SettingsAgentKind, prefs: Partial<AgentPrefs>): void => {
    const entry = { [agent]: prefs } as Partial<Record<SettingsAgentKind, Partial<AgentPrefs>>>
    void update({ agents: { [targetId]: entry } })
  }

  return (
    <div className="space-y-4">
      {visible('agents') && (
        <InfoBlock title="登录说明（不检测凭据）">
          <ul className="space-y-1.5">
            {SETTINGS_AGENT_INFO.map((info) => (
              <li key={info.id}>
                <span className="text-qn-text">{info.label}：</span>
                {info.loginPrefix}{' '}
                <code className="rounded-md bg-qn-fg/[0.06] px-1 py-0.5 font-mono text-ui-sm">
                  {info.loginCommand}
                </code>{' '}
                {info.loginSuffix}
                {info.notes.map((note) => (
                  <span key={note} className="block pl-4 text-qn-dim">· {note}</span>
                ))}
              </li>
            ))}
          </ul>
          <p className="mt-2 text-qn-dim">
            检测只运行可执行文件的 --version，不会开启会话、不会消耗额度、不会读取登录凭据。
          </p>
        </InfoBlock>
      )}

      {visible('agents') && (
        <div className="space-y-4">
          {targets.map((target) => {
            const connected = states[target.id]?.state === 'ready'
            return (
              <section key={target.id} className="space-y-2">
                <div className="flex flex-wrap items-center gap-2">
                  <h3 className="text-ui font-medium text-qn-text">{target.name}</h3>
                  <span className="truncate text-ui-sm text-qn-dim">{targetLabel(target)}</span>
                  {!connected && <Badge tone="muted">连接后检测</Badge>}
                </div>
                <div className="space-y-2">
                  {SETTINGS_AGENT_INFO.map((info) => (
                    <AgentRow
                      key={`${target.id}:${info.id}`}
                      targetId={target.id}
                      info={info}
                      prefs={agentPrefs(settings, target.id, info.id)}
                      connected={connected}
                      onPatch={(prefs) => patchAgent(target.id, info.id, prefs)}
                    />
                  ))}
                </div>
              </section>
            )
          })}
          {targets.length === 0 && (
            <p className="text-ui-sm text-qn-dim">正在读取目标列表…</p>
          )}
        </div>
      )}
    </div>
  )
}
