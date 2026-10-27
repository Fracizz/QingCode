import { useEffect, useRef, useState } from 'react'
import { Download, RefreshCw, X } from 'lucide-react'
import ModalOverlay from './ModalOverlay'
import Tooltip from './Tooltip'
import { useI18n } from '../lib/i18n'
import { safeInvoke } from '../lib/tauri'
import {
  connectionFromImport,
  sshImportTarget,
  type SshImportCandidates,
} from '../lib/sshConfigImport'
import { sshConnectionTarget } from '../lib/sshWorkspace'
import { useProjectStore } from '../store/projectStore'

export default function SshImportDialog({
  onClose,
  onImported,
}: {
  onClose: () => void
  onImported: (id: string) => void
}) {
  const { t } = useI18n()
  const connections = useProjectStore(s => s.sshConnections)
  const [data, setData] = useState<SshImportCandidates | null>(null)
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const [query, setQuery] = useState('')
  const [selected, setSelected] = useState<Set<string>>(new Set())
  // Also track successful writes if a later item fails; retry must never duplicate them.
  const [imported, setImported] = useState<Set<string>>(new Set())
  const savingRef = useRef(false)
  const mountedRef = useRef(true)
  const requestRef = useRef(0)
  const firstImportedRef = useRef<string | null>(null)

  const load = async () => {
    const request = ++requestRef.current
    setLoading(true)
    setError('')
    setSelected(new Set())
    try {
      const result = await safeInvoke<SshImportCandidates>(
        '读取本机 SSH 配置',
        'ssh_import_candidates'
      )
      if (mountedRef.current && request === requestRef.current) setData(result)
    } catch (reason) {
      if (mountedRef.current && request === requestRef.current) {
        setData(null)
        setError(String(reason))
      }
    } finally {
      if (mountedRef.current && request === requestRef.current) setLoading(false)
    }
  }

  useEffect(() => {
    mountedRef.current = true
    queueMicrotask(() => {
      if (mountedRef.current) void load()
    })
    return () => {
      mountedRef.current = false
    }
  }, [])

  const existing = new Set([...connections.map(sshImportTarget), ...imported])
  const needle = query.trim().toLowerCase()
  const visible = (data?.candidates ?? []).filter(item =>
    `${item.name} ${item.host} ${item.username} ${item.port}`.toLowerCase().includes(needle)
  )
  const available = visible.filter(item => !item.issue && !existing.has(sshImportTarget(item)))
  const pending = (data?.candidates ?? []).filter(
    item => selected.has(item.name) && !item.issue && !existing.has(sshImportTarget(item))
  )
  const allSelected = available.length > 0 && available.every(item => selected.has(item.name))

  const toggle = (name: string) =>
    setSelected(previous => {
      const next = new Set(previous)
      if (next.has(name)) next.delete(name)
      else next.add(name)
      return next
    })

  const close = () => {
    if (savingRef.current) return
    if (firstImportedRef.current) onImported(firstImportedRef.current)
    onClose()
  }

  const importSelected = async () => {
    if (savingRef.current || pending.length === 0) return
    savingRef.current = true
    setSaving(true)
    setError('')
    const targets = new Set(existing)
    let count = 0
    try {
      for (const candidate of pending) {
        const target = sshImportTarget(candidate)
        if (targets.has(target)) continue
        // Re-read the store before each write in case connections changed while importing.
        if (
          useProjectStore.getState().sshConnections.some(item => sshImportTarget(item) === target)
        )
          continue
        const connection = connectionFromImport(candidate)
        await useProjectStore.getState().saveSshConnection(connection)
        targets.add(target)
        firstImportedRef.current ??= connection.id
        count++
        setImported(previous => new Set([...previous, target]))
      }
      useProjectStore.getState().pushToast('success', t('已导入 {count} 个 SSH 连接', { count }))
      if (firstImportedRef.current) onImported(firstImportedRef.current)
      onClose()
    } catch (reason) {
      setError(
        t('导入失败，已保存 {count} 个连接，可重试剩余项：{error}', {
          count,
          error: String(reason),
        })
      )
    } finally {
      savingRef.current = false
      setSaving(false)
    }
  }

  return (
    <ModalOverlay onDismiss={close} zIndex="z-[140]">
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="ssh-import-title"
        className="modal-content-enter flex max-h-[80vh] w-[680px] max-w-[94vw] flex-col overflow-hidden rounded-lg border border-dialog-border bg-dialog text-fg shadow-elevation-3"
      >
        <div className="flex items-center gap-2 border-b border-dialog-separator bg-dialog-chrome px-4 py-3">
          <Download size={16} className="text-fg-muted" />
          <h2 id="ssh-import-title" className="flex-1 text-ui-lg font-semibold">
            {t('导入已有连接')}
          </h2>
          <Tooltip label={t('关闭')}>
            <button
              type="button"
              aria-label={t('关闭')}
              disabled={saving}
              onClick={close}
              className="rounded p-1 hover:bg-bg-hover disabled:opacity-40"
            >
              <X size={16} />
            </button>
          </Tooltip>
        </div>
        <div className="space-y-3 px-4 pt-3">
          <p className="text-ui-sm text-fg-muted">
            {t('勾选本机 SSH 配置中的连接后确认导入。首次连接时需确认主机指纹。')}
          </p>
          <p className="break-all font-mono text-ui-sm text-fg-dim">
            {data?.path ?? '~/.ssh/config'}
          </p>
          <input
            data-modal-autofocus
            aria-label={t('搜索连接')}
            placeholder={t('搜索名称、主机或用户名')}
            value={query}
            onChange={event => setQuery(event.target.value)}
            disabled={saving}
            className="w-full rounded border border-dialog-border bg-dialog-input px-2.5 py-1.5 text-ui outline-none focus:border-accent"
          />
          <div className="flex items-center justify-between text-ui-sm">
            <label className="flex items-center gap-2">
              <input
                type="checkbox"
                checked={allSelected}
                disabled={loading || saving || available.length === 0}
                onChange={() =>
                  setSelected(previous => {
                    const next = new Set(previous)
                    for (const item of available) {
                      if (allSelected) next.delete(item.name)
                      else next.add(item.name)
                    }
                    return next
                  })
                }
              />
              {t('全选当前结果')}
            </label>
            <button
              type="button"
              disabled={loading || saving}
              onClick={() => void load()}
              className="inline-flex items-center gap-1 rounded px-2 py-1 hover:bg-bg-hover disabled:opacity-40"
            >
              <RefreshCw size={12} />
              {t('重新读取')}
            </button>
          </div>
        </div>
        <div
          aria-busy={loading || saving}
          className="mx-4 my-3 min-h-24 overflow-y-auto rounded border border-dialog-border"
        >
          {loading ? (
            <p className="p-4 text-ui-sm text-fg-muted">{t('正在读取…')}</p>
          ) : visible.length === 0 ? (
            <p className="p-4 text-ui-sm text-fg-muted">
              {t(
                data?.candidates.length
                  ? '没有匹配的连接'
                  : '未找到可导入的 Host 配置，请检查本机 ~/.ssh/config。'
              )}
            </p>
          ) : (
            visible.map(item => {
              const added = existing.has(sshImportTarget(item))
              const disabled = saving || added || Boolean(item.issue)
              return (
                <label
                  key={item.name}
                  className={`flex items-start gap-3 border-b border-dialog-separator px-3 py-2.5 last:border-0 ${disabled ? 'text-fg-muted' : 'hover:bg-bg-hover'}`}
                >
                  <input
                    type="checkbox"
                    aria-label={item.name}
                    checked={selected.has(item.name) && !added && !item.issue}
                    disabled={disabled}
                    onChange={() => toggle(item.name)}
                    className="mt-1 shrink-0"
                  />
                  <span className="min-w-0 flex-1 space-y-0.5">
                    <span className="block break-all text-ui">{item.name}</span>
                    <span className="block break-all font-mono text-ui-sm text-fg-muted">
                      {sshConnectionTarget(item)}
                    </span>
                    {item.privateKeyPath && (
                      <span className="block break-all font-mono text-ui-sm text-fg-dim">
                        {item.privateKeyPath}
                      </span>
                    )}
                    {item.issue && (
                      <span className="block text-ui-sm text-warn">{t(item.issue)}</span>
                    )}
                  </span>
                  {added && (
                    <span className="shrink-0 rounded bg-dialog-active px-1.5 py-0.5 text-ui-sm">
                      {t('已添加')}
                    </span>
                  )}
                </label>
              )
            })
          )}
        </div>
        {error && (
          <p role="alert" className="mx-4 mb-3 break-words text-ui-sm text-danger">
            {error}
          </p>
        )}
        <div className="flex items-center justify-between gap-3 border-t border-dialog-separator bg-dialog-chrome px-4 py-3">
          <span className="text-ui-sm text-fg-muted">
            {t('已选 {count} 项', { count: pending.length })}
          </span>
          <div className="flex gap-2">
            <button
              type="button"
              onClick={close}
              disabled={saving}
              className="rounded border border-dialog-border px-3 py-1.5 text-ui hover:bg-bg-hover disabled:opacity-40"
            >
              {t('取消')}
            </button>
            <button
              type="button"
              onClick={() => void importSelected()}
              disabled={loading || saving || pending.length === 0}
              className="rounded bg-action px-3 py-1.5 text-ui text-on-action hover:bg-action/90 disabled:opacity-50"
            >
              {t(saving ? '正在导入…' : '确认导入')}
            </button>
          </div>
        </div>
      </div>
    </ModalOverlay>
  )
}
