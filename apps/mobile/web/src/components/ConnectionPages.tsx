import { Check, KeyRound, Pencil, Plus, Settings, Trash2 } from 'lucide-react'
import { useEffect, useState } from 'react'
import { callDevice } from '../client'
import { formatAddress, isValidPairingCode, normalizeFingerprint, parseAddress, parsePairingLink } from '../link'
import { getWindowNativePort } from '../native'
import { friendlyError } from '../state'
import { useApp } from '../store'
import type { ConnectionStatus } from '../types'
import { MobileSettings } from './MobileSettings'
import { PullToRefresh } from './PullToRefresh'
import { Badge, Button, Card, Dialog, Field, Header, Loading, Note, SheetAction, StatusDot } from './ui'
import { WorkspaceIcon } from './WorkspaceHome'

const stateText: Record<ConnectionStatus, string> = {
  online: '在线',
  offline: '离线',
  mismatch: '证书已变化',
  checking: '检测中…',
  unknown: '待连接',
}

function statusTone(status: ConnectionStatus): 'ok' | 'warn' | 'danger' | 'muted' {
  if (status === 'online') return 'ok'
  if (status === 'checking') return 'warn'
  if (status === 'mismatch') return 'danger'
  return 'muted'
}

export function ConnectionsPage() {
  const connections = useApp((s) => s.connections)
  const statuses = useApp((s) => s.connectionStatus)
  const latencies = useApp((s) => s.connectionLatencyMs)
  const activeId = useApp((s) => s.activeId)
  const booting = useApp((s) => s.booting)
  const mock = useApp((s) => s.mock)
  const eventsConnected = useApp((s) => s.eventsConnected)
  const error = useApp((s) => s.error)
  const notice = useApp((s) => s.notice)
  const needsRepair = useApp((s) => s.needsRepair)
  const beginRepair = useApp((s) => s.beginRepair)
  const activate = useApp((s) => s.activate)
  const openAddForm = useApp((s) => s.openAddForm)
  const openEditForm = useApp((s) => s.openEditForm)
  const removeConnection = useApp((s) => s.removeConnection)
  const pasteFromClipboard = useApp((s) => s.pasteFromClipboard)
  const refreshStatuses = useApp((s) => s.refreshStatuses)
  const clearError = useApp((s) => s.clearError)
  const clearNotice = useApp((s) => s.clearNotice)
  const [menu, setMenu] = useState<string | null>(null)
  const [pendingDelete, setPendingDelete] = useState<string | null>(null)
  const [settings, setSettings] = useState(false)
  useEffect(() => {
    if (!booting && connections.length) void refreshStatuses()
  }, [booting, connections, refreshStatuses])

  const selected = connections.find((item) => item.id === menu)
  const addFromClipboard = () => {
    openAddForm()
    void pasteFromClipboard()
  }
  return (
    <>
      <PullToRefresh className="qn-body qn-scroll qn-workspace qn-rise"
        label="连接" disabled={booting || connections.length === 0} onRefresh={refreshStatuses}>
        <header className="qn-workspace-title" data-connected={eventsConnected}>
          <div className="qn-workspace-context">
            <span className="text-[13px]">{[connections.length ? `已配对 ${connections.length} 台电脑` : '尚未配对电脑', mock && '浏览器预览'].filter(Boolean).join(' · ')}</span>
            <div className="flex">
              {connections.length > 0 && (
                <Button variant="ghost" className="qn-list-action" onClick={() => void refreshStatuses()} aria-label="刷新连接">
                  <WorkspaceIcon name="refresh" />
                </Button>
              )}
              <Button variant="ghost" className="qn-list-action" onClick={() => setSettings(true)} aria-label="应用设置">
                <Settings size={20} strokeWidth={1.75} />
              </Button>
            </div>
          </div>
        </header>
        {error && <Note message={error} tone="error" onClose={clearError} />}
        {notice && <Note message={notice} tone="warn" onClose={clearNotice} />}
        {booting ? <Loading text="正在读取已保存的连接…" /> : connections.length === 0 ? (
          <div className="qn-onboard">
            <h1 className="qn-hero-title">QingCode</h1>
            <p className="qn-onboard-lead">在手机上继续电脑里的 Agent 会话</p>
            <ol className="qn-onboard-steps">
              <li><span>1</span>电脑端点侧栏底部「手机连接」并启用</li>
              <li><span>2</span>复制连接信息，或用手机扫码</li>
              <li><span>3</span>回到这里导入，输入配对密码</li>
            </ol>
            <Button variant="primary" className="w-full" onClick={addFromClipboard}>从剪贴板导入</Button>
            <button type="button" className="qn-dashed-action qn-pressable" onClick={openAddForm}>
              <Plus size={17} aria-hidden />扫码或手动添加
            </button>
          </div>
        ) : (
          <>
            <div className="qn-list-group">
              {connections.map((conn) => {
                const current = conn.id === activeId
                const repair = needsRepair[conn.id]
                const status = current && eventsConnected ? 'online' : statuses[conn.id] ?? 'unknown'
                const tone = repair ? 'danger' : statusTone(status)
                const latency = !repair && status === 'online' ? latencies[conn.id] : null
                return (
                  <div key={conn.id} className="qn-row qn-list-row">
                    <button type="button" className="qn-row-trigger" onClick={() => void activate(conn.id, 'targets')}>
                      <StatusDot tone={tone} />
                      <span className="qn-row-copy">
                        <span className="qn-list-primary qn-clamp-2">{conn.name}</span>
                        <span className="qn-subtitle block">{current ? '当前电脑 · ' : ''}{formatAddress(conn.host, conn.port)}</span>
                      </span>
                      <span className="flex shrink-0 flex-col items-end gap-1">
                        <Badge tone={tone}>{repair ? '重新配对' : stateText[status]}</Badge>
                        {latency != null && <span className="text-[11px] text-qn-muted tabular-nums" title="手机到电脑的 HTTPS 探测耗时">{latency} ms</span>}
                      </span>
                    </button>
                    <Button variant="ghost" className="qn-list-action" onClick={() => setMenu(conn.id)} aria-label={`${conn.name} 的连接操作`}>
                      <WorkspaceIcon name="more" />
                    </Button>
                  </div>
                )
              })}
            </div>
            {/* 已有连接时这里不是主操作：只留虚线入口，导入方式在添加页里选。 */}
            <button type="button" className="qn-dashed-action qn-pressable" onClick={openAddForm}>
              <Plus size={17} aria-hidden />添加连接
            </button>
          </>
        )}
      </PullToRefresh>
      {settings && <MobileSettings onClose={() => setSettings(false)} />}
      {selected && (
        <Dialog title={selected.name} onClose={() => setMenu(null)}>
          <p className="mb-3 text-xs text-qn-muted">{formatAddress(selected.host, selected.port)}</p>
          <div className="grid">
            <SheetAction icon={Pencil} onClick={() => { setMenu(null); openEditForm(selected.id) }}>编辑连接</SheetAction>
            <SheetAction icon={KeyRound} onClick={() => { setMenu(null); beginRepair(selected.id) }}>重新配对</SheetAction>
            <SheetAction icon={Trash2} danger onClick={() => { setMenu(null); setPendingDelete(selected.id) }}>删除连接</SheetAction>
          </div>
        </Dialog>
      )}
      {pendingDelete && (
        <Dialog title="删除连接" onClose={() => setPendingDelete(null)}>
          <p className="mb-4 text-sm text-qn-muted">删除后需要重新配对才能访问这台电脑。</p>
          <div className="flex gap-2">
            <Button className="flex-1" onClick={() => setPendingDelete(null)}>取消</Button>
            <Button className="flex-1" variant="danger" onClick={() => {
              const id = pendingDelete
              setPendingDelete(null)
              void removeConnection(id)
            }}>删除</Button>
          </div>
        </Dialog>
      )}
    </>
  )
}

export function ConnectionFormPage() {
  const form = useApp((s) => s.form)
  const closeForm = useApp((s) => s.closeForm)
  const setFormPaste = useApp((s) => s.setFormPaste)
  const parsePaste = useApp((s) => s.parsePaste)
  const pasteFromClipboard = useApp((s) => s.pasteFromClipboard)
  const updateDraft = useApp((s) => s.updateDraft)
  const testConnection = useApp((s) => s.testConnection)
  const pairAndSave = useApp((s) => s.pairAndSave)
  const saveEdit = useApp((s) => s.saveEdit)
  const [scanning, setScanning] = useState(false)
  const [scanError, setScanError] = useState<string | null>(null)
  const [reimport, setReimport] = useState(false)

  if (!form) return null
  const isEdit = form.mode === 'edit'
  const isRepair = form.mode === 'repair'
  const title = isEdit ? '编辑连接' : isRepair ? '重新配对' : '添加连接'
  const imported = Boolean(normalizeFingerprint(form.draft.fp))
  const codeOk = isValidPairingCode(form.draft.code)
  const onHostBlur = () => {
    const parsed = parseAddress(form.draft.host)
    if (parsed && parsed.host !== form.draft.host) {
      updateDraft('host', parsed.host)
      if (parsed.port !== null) updateDraft('port', String(parsed.port))
    }
  }

  const scan = async () => {
    const requestForm = useApp.getState().form
    setScanning(true)
    setScanError(null)
    try {
      const link = await callDevice<string | null>('pair.scan', {}, 300_000)
      if (!link || requestForm !== useApp.getState().form) return
      if (!parsePairingLink(link)) {
        setScanError('二维码里没有可用的 QingCode Next 配对链接。')
        return
      }
      setFormPaste(link)
      parsePaste()
      setReimport(false)
    } catch (err) {
      setScanError(friendlyError(err, '扫码不可用，可用系统相机或粘贴连接信息。'))
    } finally {
      setScanning(false)
    }
  }

  return (
    <>
      <Header title={title}
        subtitle={isEdit ? '修改名称或地址' : isRepair ? '请从同一台电脑复制新的连接信息' : '配对到自己的电脑'}
        onBack={form.saving ? undefined : closeForm} />
      <fieldset className="qn-body qn-scroll min-w-0" disabled={form.saving}>
        {!isEdit && imported && !reimport && (
          <div className="qn-imported mb-3">
            <Check size={16} className="shrink-0 text-qn-ok" aria-hidden />
            <span className="min-w-0 flex-1">已读取地址与证书指纹</span>
            <button type="button" className="qn-note-action" onClick={() => setReimport(true)}>重新导入</button>
          </div>
        )}
        {!isEdit && (!imported || reimport) && (
          <Card className="mb-3">
            <p className="mb-3 text-sm">在电脑端「手机连接」复制连接信息，再在这里导入。</p>
            <Button className="w-full" onClick={() => { setScanError(null); setReimport(false); void pasteFromClipboard() }}>
              从剪贴板导入
            </Button>
            {getWindowNativePort() && (
              <Button className="mt-2 w-full" disabled={scanning} onClick={() => void scan()}>
                {scanning ? '正在扫码…' : '扫码导入'}
              </Button>
            )}
            <details className="qn-details mt-1">
              <summary>手动粘贴</summary>
              <Field label="连接信息">
                <textarea className="qn-textarea" rows={3} value={form.paste} placeholder="粘贴电脑端复制的连接信息…"
                  onChange={(event) => setFormPaste(event.target.value)} />
              </Field>
              <Button className="w-full" disabled={!form.paste.trim()} onClick={() => { setReimport(false); parsePaste() }}>导入信息</Button>
            </details>
            {scanError && <Note message={scanError} tone="warn" onClose={() => setScanError(null)} />}
          </Card>
        )}

        {(imported || isEdit) && (
          <Card>
            <Field label="名称">
              <input className="qn-input" value={form.draft.name} placeholder="例如：工作电脑"
                onChange={(event) => updateDraft('name', event.target.value)} />
            </Field>
            <p className="qn-subtitle qn-mono mb-1">{formatAddress(form.draft.host, Number(form.draft.port))}</p>
            <details className="qn-details" open={isEdit || undefined}>
              <summary>地址、端口和证书指纹</summary>
              <Field label="主机" hint="IPv4、IPv6 或域名，也可输入 host:port">
                <input className="qn-input qn-mono" value={form.draft.host} placeholder="例如 frp.example.com:7001"
                  autoCapitalize="off" autoCorrect="off" spellCheck={false}
                  onChange={(event) => updateDraft('host', event.target.value)} onBlur={onHostBlur} />
              </Field>
              <Field label="端口">
                <input className="qn-input qn-mono" inputMode="numeric" value={form.draft.port}
                  onChange={(event) => updateDraft('port', event.target.value)} />
              </Field>
              <div className="qn-label">证书指纹</div>
              <div className="qn-mono mb-3 rounded-xl border border-qn-border bg-qn-field p-2 text-xs">
                {normalizeFingerprint(form.draft.fp) ?? '待导入'}
              </div>
            </details>
            {!isEdit && (
              <Field label="配对密码" hint="只在配对时使用">
                <input className="qn-input" type="password" value={form.draft.code} placeholder="电脑端设置的配对密码"
                  autoComplete="off" autoCapitalize="off" autoCorrect="off" spellCheck={false}
                  onChange={(event) => updateDraft('code', event.target.value)} />
              </Field>
            )}
            {isEdit && (
              <details className="qn-details">
                <summary>从新连接信息导入地址</summary>
                <Field label="新连接信息">
                  <textarea className="qn-textarea" rows={2} value={form.paste}
                    onChange={(event) => setFormPaste(event.target.value)} />
                </Field>
                <div className="mb-3 flex flex-wrap gap-2">
                  <Button className="flex-1" onClick={() => void pasteFromClipboard()}>从剪贴板导入</Button>
                  <Button className="flex-1" disabled={!form.paste.trim()} onClick={parsePaste}>导入地址</Button>
                </div>
              </details>
            )}
            {form.probe && <Note message={`指纹核对通过 · ${form.probe.name || '电脑'}`} tone="ok" />}
            {!isEdit && form.draft.code && !codeOk && <Note message="配对密码需要 6–20 位且不含空白字符。" tone="warn" />}
          </Card>
        )}
        {form.error && <div className="mt-3"><Note message={form.error} tone="error" /></div>}
        {form.fpMismatch && <div className="mt-3"><Note message={form.fpMismatch} tone="error" /></div>}
      </fieldset>
      {(imported || isEdit) && (
        <div className="qn-footer flex flex-wrap gap-2">
          <Button className="flex-1" disabled={form.testing || form.saving} onClick={() => void testConnection()}>
            {form.testing ? '测试中…' : '测试连接'}
          </Button>
          <Button className="flex-1" variant="primary" disabled={form.testing || form.saving || Boolean(form.fpMismatch)}
            onClick={() => void (isEdit ? saveEdit() : pairAndSave())}>
            {form.saving ? '保存中…' : isEdit ? '保存修改' : '配对并保存'}
          </Button>
        </div>
      )}
    </>
  )
}
