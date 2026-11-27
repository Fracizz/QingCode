import { Upload, X } from 'lucide-react'
import { t, translateMessage } from '@qn/codex-client'
import { useLegacy } from '../store/legacy'
import { useTargets } from '../store/targets'
import { Checkbox, ErrorNote, IconButton, Modal, Spinner } from './ui'

export function LegacyBanner() {
  const detect = useLegacy((s) => s.detect)
  const dismissed = useLegacy((s) => s.dismissed)
  const open = useLegacy((s) => s.open)
  const dismiss = useLegacy((s) => s.dismiss)
  const sshCount = useTargets((s) => s.targets.filter((target) => target.kind === 'ssh').length)

  if (!detect?.found || dismissed || sshCount > 0) return null
  const total =
    detect.counts.connections + detect.counts.localProjects + detect.counts.sshProjects
  // 旧版是整宽横幅，挤占所有栏的高度；改成侧栏底部的小卡片，一次性提示不打断主流程。
  return (
    <div className="qn-pop rounded-lg border border-qn-border bg-qn-brand/[0.06] p-2.5 text-ui-sm">
      <div className="flex items-start gap-2">
        <Upload size={14} className="mt-0.5 shrink-0 text-qn-brand" />
        <span className="min-w-0 flex-1 leading-5 text-qn-text/90">
          {t('检测到旧版 QingCode 数据（约 {total} 条连接与项目）', { total })}
        </span>
        <IconButton label={t('不再提示')} size="sm" onClick={dismiss}>
          <X size={13} />
        </IconButton>
      </div>
      <button className="qn-button mt-2 w-full py-1 text-ui-sm" onClick={open}>
        {t('导入到新版本')}
      </button>
    </div>
  )
}

export function LegacyDialog() {
  const dialogOpen = useLegacy((s) => s.dialogOpen)
  const detect = useLegacy((s) => s.detect)
  const path = useLegacy((s) => s.path)
  const includeSecrets = useLegacy((s) => s.includeSecrets)
  const busy = useLegacy((s) => s.busy)
  const error = useLegacy((s) => s.error)
  const result = useLegacy((s) => s.result)
  const setPath = useLegacy((s) => s.setPath)
  const setIncludeSecrets = useLegacy((s) => s.setIncludeSecrets)
  const pickFile = useLegacy((s) => s.pickFile)
  const runImport = useLegacy((s) => s.runImport)
  const close = useLegacy((s) => s.close)

  if (!dialogOpen) return null

  const counts = detect?.counts
  return (
    <Modal
      title={t('导入旧版 QingCode 数据')}
      width="max-w-xl"
      onClose={close}
      footer={
        <div className="flex justify-end gap-2">
          <button className="qn-button-subtle" type="button" onClick={close}>
            {result ? t('完成') : t('取消')}
          </button>
          {!result && (
            <button className="qn-button" type="button" disabled={busy} onClick={() => void runImport()}>
              {busy ? t('导入中…') : t('开始导入')}
            </button>
          )}
        </div>
      }
    >
      <div className="space-y-4">
        <div>
          <div className="mb-1 text-ui-sm text-qn-muted">{t('来源数据库')}</div>
          <div className="flex gap-2">
            <input
              className="qn-input min-w-0 flex-1 font-mono text-ui-sm"
              value={path}
              placeholder={t('qingcode.db 路径')}
              onChange={(event) => setPath(event.target.value)}
            />
            <button className="qn-button-subtle shrink-0" type="button" onClick={() => void pickFile()}>
              {t('另选文件')}
            </button>
          </div>
          <p className="mt-1 text-ui-sm text-qn-muted">
            {t('旧版可能正在运行，导入会先复制数据库再只读打开，不会改动原文件。')}
          </p>
        </div>

        <div className="rounded-lg border border-qn-border bg-qn-inset p-3">
          <div className="mb-2 text-ui-sm text-qn-muted">{t('预览数量')}</div>
          {counts ? (
            <div className="grid grid-cols-2 gap-2 text-ui-sm">
              <span>{t('SSH 连接：{count}', { count: counts.connections })}</span>
              <span>{t('本机项目：{count}', { count: counts.localProjects })}</span>
              <span>{t('远端项目：{count}', { count: counts.sshProjects })}</span>
              <span>{t('已保存密码：{count}', { count: counts.secrets })}</span>
            </div>
          ) : (
            <div className="text-ui-sm text-qn-muted">{busy ? t('正在检测…') : t('未检测到旧版数据')}</div>
          )}
        </div>

        <div className="space-y-1">
          <Checkbox checked={includeSecrets} onChange={setIncludeSecrets}>
            {t('同时导入已保存的密码 / 口令')}
          </Checkbox>
          <p className="pl-5 text-ui-sm leading-5 text-qn-muted">
            {t('用本机系统加密重新保存（Windows DPAPI），不勾选则只导入连接与项目。')}
          </p>
        </div>

        {busy && <Spinner label={t('正在导入，请稍候…')} />}
        <ErrorNote message={error} onRetry={() => void runImport()} />

        {result && (
          <div className="space-y-2 rounded-lg border border-qn-border bg-emerald-400/5 p-3 text-ui-sm">
            <div className="font-medium text-emerald-300">{t('导入完成')}</div>
            <div className="grid grid-cols-2 gap-1">
              <span>{t('连接：{count}', { count: result.imported.targets })}</span>
              <span>{t('项目：{count}', { count: result.imported.projects })}</span>
              <span>{t('主机指纹：{count}', { count: result.imported.hostKeys })}</span>
              <span>{t('密码：{count}', { count: result.imported.secrets })}</span>
            </div>
            {result.skipped.length > 0 && (
              <div className="pt-1">
                <div className="mb-1 text-qn-muted">{t('跳过 {count} 项：', { count: result.skipped.length })}</div>
                <ul className="max-h-32 space-y-1 overflow-y-auto">
                  {result.skipped.map((item, index) => (
                    <li key={`${item.kind}-${item.name}-${index}`} className="flex gap-2">
                      <X size={11} className="mt-0.5 shrink-0 text-qn-danger" />
                      <span className="min-w-0 flex-1">
                        [{item.kind}] {t('{name}：{reason}', { name: translateMessage(item.name), reason: translateMessage(item.reason) })}
                      </span>
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </div>
        )}
      </div>
    </Modal>
  )
}
