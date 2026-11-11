import { useServerOperationStore, dismissServerOperation, serverOperationForProject, setServerOperationBackground } from '../store/serverOperationStore'
import { useSshOpeningStore } from '../store/sshOpeningStore'
import { useUIStore } from '../store/uiStore'
import { useI18n } from '../lib/i18n'
import ServerOperationProgress from './ServerOperationProgress'

export default function ServerOperationTasks() {
  const { t } = useI18n()
  const tasks = useServerOperationStore(s => s.tasks)
  const attempts = useSshOpeningStore(s => s.attempts)
  const updateRoot = useUIStore(s => s.serverUpdateRootUri)
  // 打开中的连接由打开进度卡展示同一任务，这里不重复显示。
  const shownByOpening = new Set(Object.values(attempts).map(attempt => serverOperationForProject(tasks, attempt.project)).filter(Boolean))
  return Object.values(tasks).filter(task => !task.background && task.rootUri !== updateRoot && !shownByOpening.has(task)).map(task => (
    <ServerOperationProgress key={task.rootUri} {...task} status={task.kind === 'update' ? '更新中' : '安装中'}
      actions={task.error ? <>
        <button type="button" className="rounded px-2 py-1 text-fg-muted hover:bg-bg-hover" onClick={() => dismissServerOperation(task.rootUri)}>{t('关闭')}</button>
        <button type="button" className="rounded px-2 py-1 text-accent hover:bg-bg-hover" onClick={() => task.kind === 'update' ? useUIStore.setState({ serverUpdateRootUri: task.rootUri }) : useUIStore.getState().openRemoteConnections()}>{t(task.kind === 'update' ? '更新远端服务' : '远程连接')}</button>
      </> : !task.finishedAt && (
        <button type="button" className="shrink-0 rounded px-2 py-1 text-ui-sm text-accent hover:bg-bg-hover" onClick={() => setServerOperationBackground(task.rootUri, true)}>{t('后台运行')}</button>
      )} />
  ))
}
