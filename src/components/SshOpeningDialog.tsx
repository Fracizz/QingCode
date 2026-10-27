import { AlertTriangle, Check, LoaderCircle, Server } from 'lucide-react'
import { useEffect, useState } from 'react'
import { useI18n } from '../lib/i18n'
import { sshServerPhaseKey } from '../lib/sshServerStatus'
import { sshProjectDisplayPath } from '../lib/sshWorkspace'
import { useProjectStore } from '../store/projectStore'
import { cancelSshOpening, useSshOpeningStore } from '../store/sshOpeningStore'
import { useUIStore } from '../store/uiStore'
import ModalOverlay from './ModalOverlay'

export default function SshOpeningDialog() {
  const { t } = useI18n()
  const attempt = useSshOpeningStore(s => s.attempt)
  const connections = useProjectStore(s => s.sshConnections)
  const [visibleController, setVisibleController] = useState<AbortController | null>(null)
  const controller = attempt?.controller
  useEffect(() => {
    if (!controller) return
    // Cached connections usually open immediately; avoid flashing a modal.
    const timer = setTimeout(() => setVisibleController(controller), 300)
    return () => clearTimeout(timer)
  }, [controller])
  if (!attempt || (!attempt.error && visibleController !== controller)) return null

  const { project, stage, server, error } = attempt
  if (attempt.reusingServer && !error) {
    return (
      <div className="fixed bottom-9 right-4 z-[110] flex max-w-[min(420px,90vw)] items-center gap-3 rounded-lg border border-border-strong bg-bg-elevated px-3 py-2 text-ui shadow-elevation-3">
        <div role="status" className="flex min-w-0 items-center gap-2 text-fg">
          <LoaderCircle size={14} className="shrink-0 animate-spin text-accent" aria-hidden />
          <span className="truncate">{t('正在打开项目 {name}…', { name: project.name })}</span>
        </div>
        <button type="button" onClick={cancelSshOpening} className="shrink-0 rounded px-2 py-1 text-ui-sm text-fg-muted hover:bg-bg-hover hover:text-fg">
          {t('取消打开')}
        </button>
      </div>
    )
  }
  const steps = [t('连接 SSH'), t('准备远端服务和终端'), t('读取项目文件')]
  const activeStep = stage === 'connecting' ? 0 : stage === 'service' ? 1 : 2
  const phase = server?.phase === 'readyServer' && server.transport === 'serve'
    ? t('正在准备远程终端…')
    : server ? t(sshServerPhaseKey(server.phase)) : t('正在检查远端服务')

  return (
    <ModalOverlay onDismiss={cancelSshOpening} zIndex="z-[130]">
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="ssh-opening-title"
        aria-describedby="ssh-opening-description"
        aria-busy={!error}
        className="modal-content-enter relative flex max-h-[85vh] w-full max-w-[480px] flex-col overflow-hidden rounded-lg border border-border-strong bg-bg-elevated shadow-elevation-3"
      >
        <div className="flex items-center gap-2 border-b border-border px-4 py-3">
          {error ? <AlertTriangle size={17} className="text-danger" /> : <Server size={17} className="text-accent" />}
          <h2 id="ssh-opening-title" className="text-ui-lg font-semibold text-fg">
            {error ? t('无法打开远程项目') : t('正在打开远程项目')}
          </h2>
        </div>
        <div className="min-h-0 space-y-4 overflow-y-auto px-4 py-4">
          <div>
            <div className="text-ui font-medium text-fg">{project.name}</div>
            <div className="mt-1 break-all font-mono text-ui-sm text-fg-muted">
              {sshProjectDisplayPath(project, null, connections)}
            </div>
          </div>
          <ol className="space-y-2 text-ui-sm">
            {steps.map((label, index) => (
              <li key={label} className={`flex items-center gap-2 ${index === activeStep ? 'text-fg' : 'text-fg-muted'}`}>
                {index < activeStep ? <Check size={14} className="text-ok" aria-hidden />
                  : index === activeStep && !error ? <LoaderCircle size={14} className="animate-spin text-accent" aria-hidden />
                    : <span className="inline-flex h-3.5 w-3.5 items-center justify-center" aria-hidden>·</span>}
                {label}
                {index === 1 && activeStep === 1 && !error && (
                  <span role="status" className="ml-auto text-fg-muted">{phase}</span>
                )}
              </li>
            ))}
          </ol>
          <p id="ssh-opening-description" className="text-ui-sm text-fg-muted">
            {error
              ? t('请检查连接或远端服务后重试。')
              : t('首次连接可能需要下载、上传和启动远端服务。准备完成后将自动打开项目。')}
          </p>
          {error && (
            <p role="alert" className="select-text whitespace-pre-wrap break-words rounded border border-danger/30 bg-danger/10 px-3 py-2 text-ui-sm text-danger">
              {error}
            </p>
          )}
        </div>
        <div className="flex justify-end gap-2 border-t border-border px-4 py-3">
          <button type="button" onClick={cancelSshOpening} className="rounded border border-border-strong px-3 py-1.5 text-ui text-fg hover:bg-bg-hover">
            {error ? t('关闭') : t('取消打开')}
          </button>
          {error && <>
            <button type="button" className="rounded border border-border-strong px-3 py-1.5 text-ui text-fg hover:bg-bg-hover" onClick={() => {
              cancelSshOpening()
              useUIStore.getState().openRemoteConnections()
            }}>{t('远程连接')}</button>
            <button type="button" className="rounded bg-action px-3 py-1.5 text-ui text-on-action hover:bg-action/90" onClick={() => {
              void useProjectStore.getState().switchProject(project)
            }}>{t('重试')}</button>
          </>}
        </div>
      </div>
    </ModalOverlay>
  )
}
