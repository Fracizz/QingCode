import { useState } from 'react'
import { formatAddress, isValidPairingCode, normalizeFingerprint, parseAddress } from '../link'
import { useApp } from '../store'
import type { ConnectionStatus } from '../types'
import { Badge, Button, Card, Dialog, Empty, Field, Header, Loading, Note, StatusDot } from './ui'

function statusText(status: ConnectionStatus | undefined, connected: boolean): string {
  if (connected) return '已连接'
  switch (status) {
    case 'online':
      return '在线'
    case 'offline':
      return '离线'
    case 'mismatch':
      return '证书指纹已变化'
    case 'checking':
      return '检测中…'
    default:
      return '未检测'
  }
}

function statusTone(status: ConnectionStatus | undefined, connected: boolean): 'ok' | 'warn' | 'danger' | 'muted' {
  if (connected || status === 'online') return 'ok'
  if (status === 'checking') return 'warn'
  if (status === 'offline') return 'muted'
  if (status === 'mismatch') return 'danger'
  return 'muted'
}

export function ConnectionsPage() {
  const connections = useApp((s) => s.connections)
  const statuses = useApp((s) => s.connectionStatus)
  const activeId = useApp((s) => s.activeId)
  const booting = useApp((s) => s.booting)
  const mock = useApp((s) => s.mock)
  const eventsConnected = useApp((s) => s.eventsConnected)
  const eventsError = useApp((s) => s.eventsError)
  const error = useApp((s) => s.error)
  const notice = useApp((s) => s.notice)
  const activate = useApp((s) => s.activate)
  const openAddForm = useApp((s) => s.openAddForm)
  const openEditForm = useApp((s) => s.openEditForm)
  const removeConnection = useApp((s) => s.removeConnection)
  const pasteFromClipboard = useApp((s) => s.pasteFromClipboard)
  const refreshStatuses = useApp((s) => s.refreshStatuses)
  const clearError = useApp((s) => s.clearError)
  const clearNotice = useApp((s) => s.clearNotice)
  const [pendingDelete, setPendingDelete] = useState<string | null>(null)

  const addFromClipboard = () => {
    openAddForm()
    void pasteFromClipboard()
  }

  return (
    <>
      <Header
        title="QingCode Next"
        subtitle={mock ? '浏览器开发模式（模拟电脑数据）' : '手机连接'}
        right={
          <Button variant="ghost" className="px-2" onClick={() => void refreshStatuses()} aria-label="刷新状态">
            ⟳
          </Button>
        }
      />
      <div className="qn-body qn-scroll">
        {error && <Note message={error} tone="error" onClose={clearError} />}
        {notice && <Note message={notice} tone="warn" onClose={clearNotice} />}
        {eventsError && <Note message={`事件流：${eventsError}`} tone="warn" />}
        {mock && !notice && (
          <Note message="浏览器开发模式：未检测到原生桥，页面使用内存假数据；剪贴板里已放好示例连接信息。" />
        )}
        {booting ? (
          <Loading text="正在读取已保存的连接…" />
        ) : connections.length === 0 ? (
          <Empty>
            还没有连接电脑。
            <br />
            在电脑端「手机连接」复制连接信息后粘贴导入。
          </Empty>
        ) : (
          <div className="space-y-3">
            {connections.map((conn) => {
              const connected = conn.id === activeId && eventsConnected
              const status = statuses[conn.id]
              return (
                <Card key={conn.id}>
                  <button type="button" className="qn-row" onClick={() => void activate(conn.id)}>
                    <StatusDot tone={statusTone(status, connected)} />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-sm font-medium">{conn.name}</span>
                      <span className="qn-subtitle qn-mono block">{formatAddress(conn.host, conn.port)}</span>
                    </span>
                    <Badge tone={statusTone(status, connected)}>{statusText(status, connected)}</Badge>
                  </button>
                  <div className="mt-2 flex gap-2 border-t border-qn-border pt-2">
                    <Button className="flex-1" variant="primary" onClick={() => void activate(conn.id)}>
                      进入
                    </Button>
                    <Button className="flex-1" onClick={() => openEditForm(conn.id)}>
                      编辑
                    </Button>
                    <Button className="flex-1" variant="danger" onClick={() => setPendingDelete(conn.id)}>
                      删除
                    </Button>
                  </div>
                </Card>
              )
            })}
          </div>
        )}
      </div>
      <div className="qn-footer flex gap-2">
        <Button variant="primary" className="flex-1" onClick={openAddForm}>
          ＋ 添加连接
        </Button>
        <Button className="flex-1" onClick={addFromClipboard}>
          从剪贴板导入
        </Button>
      </div>
      {pendingDelete && (
        <Dialog title="删除连接" onClose={() => setPendingDelete(null)}>
          <p className="mb-4 text-sm text-qn-muted">删除后需要重新粘贴连接信息配对，确定删除吗？</p>
          <div className="flex gap-2">
            <Button className="flex-1" onClick={() => setPendingDelete(null)}>
              取消
            </Button>
            <Button
              className="flex-1"
              variant="danger"
              onClick={() => {
                const id = pendingDelete
                setPendingDelete(null)
                void removeConnection(id)
              }}
            >
              删除
            </Button>
          </div>
        </Dialog>
      )}
    </>
  )
}

export function ConnectionFormPage() {
  const form = useApp((s) => s.form)
  const mock = useApp((s) => s.mock)
  const closeForm = useApp((s) => s.closeForm)
  const setFormPaste = useApp((s) => s.setFormPaste)
  const parsePaste = useApp((s) => s.parsePaste)
  const pasteFromClipboard = useApp((s) => s.pasteFromClipboard)
  const updateDraft = useApp((s) => s.updateDraft)
  const testConnection = useApp((s) => s.testConnection)
  const pairAndSave = useApp((s) => s.pairAndSave)
  const saveEdit = useApp((s) => s.saveEdit)

  if (!form) return null
  const isEdit = form.mode === 'edit'
  const codeOk = isValidPairingCode(form.draft.code)

  const onHostBlur = () => {
    const parsed = parseAddress(form.draft.host)
    if (parsed && parsed.host !== form.draft.host) {
      updateDraft('host', parsed.host)
      if (parsed.port !== null) updateDraft('port', String(parsed.port))
    }
  }

  return (
    <>
      <Header title={isEdit ? '编辑连接' : '添加连接'} subtitle="导入后可编辑，无需重新配对" onBack={closeForm} />
      <div className="qn-body qn-scroll">
        {!isEdit && (
          <Card className="mb-3">
            <Field label="粘贴连接信息" hint="支持从聊天软件转发的整段文字，会自动提取 qingcode-next://pair 链接">
              <textarea
                className="qn-textarea"
                rows={3}
                value={form.paste}
                placeholder="粘贴电脑端复制的连接信息…"
                onChange={(event) => setFormPaste(event.target.value)}
              />
            </Field>
            <div className="flex gap-2">
              <Button className="flex-1" onClick={() => void pasteFromClipboard()}>
                读取剪贴板
              </Button>
              <Button className="flex-1" onClick={parsePaste}>
                解析
              </Button>
            </div>
            {mock && <p className="mt-2 text-[11px] text-qn-muted">模拟密码：mock1234</p>}
          </Card>
        )}

        <Card>
          <Field label="名称">
            <input
              className="qn-input"
              value={form.draft.name}
              placeholder="例如：家里的电脑"
              onChange={(event) => updateDraft('name', event.target.value)}
            />
          </Field>
          <Field label="主机" hint="可填 IPv4 / IPv6 / 域名，支持 frp 转发；也可直接粘贴 host:port">
            <input
              className="qn-input qn-mono"
              value={form.draft.host}
              placeholder="192.168.1.2 或 frp.example.com:7001"
              autoCapitalize="off"
              autoCorrect="off"
              spellCheck={false}
              onChange={(event) => updateDraft('host', event.target.value)}
              onBlur={onHostBlur}
            />
          </Field>
          <Field label="端口" hint="可以与电脑监听端口不同（TCP 转发场景）">
            <input
              className="qn-input qn-mono"
              inputMode="numeric"
              value={String(form.draft.port)}
              onChange={(event) => updateDraft('port', event.target.value)}
            />
          </Field>
          {!isEdit && (
            <Field label="配对密码" hint="6–20 位、区分大小写；只在配对时使用，不保存到连接里">
              <input
                className="qn-input"
                type="password"
                value={form.draft.code}
                placeholder="电脑端设置的配对密码"
                autoComplete="off"
                autoCapitalize="off"
                autoCorrect="off"
                spellCheck={false}
                onChange={(event) => updateDraft('code', event.target.value)}
              />
            </Field>
          )}
          <Field label="证书指纹（只读）" hint="固定指纹；不一致时拒绝连接">
            <div className="qn-mono break-all rounded-lg border border-qn-border bg-black/20 p-2 text-[11px] leading-5">
              {normalizeFingerprint(form.draft.fp) ?? '（未解析）'}
            </div>
          </Field>

          {form.error && <Note message={form.error} tone="error" />}
          {form.fpMismatch && <Note message={form.fpMismatch} tone="error" />}
          {form.probe && (
            <Note
              message={`指纹核对通过：${form.probe.name || '电脑'} ${form.probe.version || ''}`.trim()}
              tone="ok"
            />
          )}
          {!isEdit && form.draft.code && !codeOk && (
            <Note message="配对密码需为 6–20 位且不含空白字符" tone="warn" />
          )}

          <div className="mt-2 flex gap-2">
            <Button className="flex-1" disabled={form.testing} onClick={() => void testConnection()}>
              {form.testing ? '测试中…' : '测试连接'}
            </Button>
            <Button
              className="flex-1"
              variant="primary"
              disabled={form.pairing}
              onClick={() => void (isEdit ? saveEdit() : pairAndSave())}
            >
              {form.pairing ? '配对中…' : isEdit ? '保存修改' : '配对并保存'}
            </Button>
          </div>
        </Card>
        {isEdit && (
          <p className="mt-3 text-xs text-qn-muted">
            修改名称 / 主机 / 端口不需要重新配对；token 与证书指纹保持不变。
          </p>
        )}
      </div>
    </>
  )
}
