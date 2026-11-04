import { useEffect, useRef, useState } from 'react'
import type { Project } from '../types'
import { useI18n } from '../lib/i18n'
import { inspectServerPackage, recoverServerPackage, type ServerPackageInfo } from '../lib/sshServerRecovery'

export default function SshServerRecovery({ project, opening, onRetry, onBusyChange }: {
  project: Project
  opening: AbortController
  onRetry: () => Promise<void>
  onBusyChange: (busy: boolean) => void
}) {
  const { t } = useI18n()
  const [info, setInfo] = useState<ServerPackageInfo | null>(null)
  const [failure, setFailure] = useState('')
  const [busy, setBusy] = useState<'choose' | 'download' | null>(null)
  const lifecycle = useRef<AbortController | null>(null)
  const actionPending = useRef(false)
  const actionGeneration = useRef(0)
  useEffect(() => {
    const controller = new AbortController()
    lifecycle.current = controller
    actionPending.current = false
    actionGeneration.current = 0
    void inspectServerPackage(project.path).then(value => {
      if (!controller.signal.aborted && actionGeneration.current === 0) setInfo(value)
    }).catch(() => { /* The opening error remains authoritative if SSH is unavailable. */ })
    return () => controller.abort()
  }, [project.path, opening])
  useEffect(() => {
    onBusyChange(busy !== null)
    return () => onBusyChange(false)
  }, [busy, onBusyChange])

  const recover = async (action: 'choose' | 'download') => {
    const controller = lifecycle.current
    if (!controller || controller.signal.aborted || actionPending.current) return
    actionPending.current = true
    actionGeneration.current++
    setBusy(action)
    setFailure('')
    try {
      if (await recoverServerPackage(project, action, controller.signal, setInfo)) {
        controller.signal.throwIfAborted()
        await onRetry()
      }
    } catch (error) {
      if (!controller.signal.aborted) setFailure(String(error))
    } finally {
      if (!controller.signal.aborted) {
        actionPending.current = false
        setBusy(null)
      }
    }
  }
  const buttonClass = 'rounded border border-border-strong px-2.5 py-1.5 text-ui-sm text-fg hover:bg-bg-hover disabled:opacity-50'
  return (
    <section aria-label={t('修复远端服务包')} className="space-y-3 rounded border border-border p-3 text-ui-sm">
      <p className="text-fg-muted">{t('重新选择与客户端版本一致的 servers 目录，或在线下载。验证通过后仅更新此项目并自动重试。')}</p>
      {info && <dl className="space-y-1 text-fg-muted">
        <div><dt className="inline">{t('客户端需要的版本')}：</dt><dd className="inline font-mono text-fg">{info.expectedVersion}</dd></div>
        <div><dt className="inline">{t('服务包版本')}：</dt><dd className="inline font-mono text-fg">{info.packageVersion || t('未知')}</dd></div>
        <div><dt>{t('服务包来源')}</dt><dd className="select-text break-all font-mono">{info.sourcePath || t('未找到服务包')}</dd></div>
      </dl>}
      {(failure || info?.problem) && <p role="alert" className="select-text break-words text-danger">{failure || info?.problem}</p>}
      <div className="flex flex-wrap gap-2">
        <button type="button" disabled={busy !== null} className={buttonClass} onClick={() => void recover('choose')}>{t('重新选择服务目录')}</button>
        <button type="button" disabled={busy !== null} className={buttonClass} onClick={() => void recover('download')}>{t('在线下载并重试')}</button>
      </div>
      {busy && <p role="status" className="text-fg-muted">{busy === 'download' ? t('正在本机下载、校验并准备重试…') : t('正在校验服务目录并准备重试…')}</p>}
    </section>
  )
}
