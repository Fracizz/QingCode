import { Upload, X } from 'lucide-react'
import { useLegacy } from '../store/legacy'
import { useTargets } from '../store/targets'
import { Checkbox, ErrorNote, Modal, Spinner } from './ui'

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
    <div className="qn-pop rounded-lg border border-qn-brand/25 bg-qn-brand/[0.06] p-2.5 text-xs">
      <div className="flex items-start gap-2">
        <Upload size={14} className="mt-0.5 shrink-0 text-qn-brand" />
        <span className="min-w-0 flex-1 leading-5 text-qn-text/90">
          检测到旧版 QingCode 数据（约 {total} 条连接与项目）
        </span>
        <button
          type="button"
          className="shrink-0 rounded p-0.5 text-qn-dim hover:text-qn-text"
          aria-label="不再提示"
          title="不再提示"
          onClick={dismiss}
        >
          <X size={12} />
        </button>
      </div>
      <button className="qn-button mt-2 w-full py-1 text-[11px]" onClick={open}>
        导入到新版本
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
      title="导入旧版 QingCode 数据"
      width="max-w-xl"
      onClose={close}
      footer={
        <div className="flex justify-end gap-2">
          <button className="qn-button-subtle" type="button" onClick={close}>
            {result ? '完成' : '取消'}
          </button>
          {!result && (
            <button className="qn-button" type="button" disabled={busy} onClick={() => void runImport()}>
              {busy ? '导入中…' : '开始导入'}
            </button>
          )}
        </div>
      }
    >
      <div className="space-y-4">
        <div>
          <div className="mb-1 text-xs text-qn-muted">来源数据库</div>
          <div className="flex gap-2">
            <input
              className="qn-input min-w-0 flex-1 font-mono text-[11px]"
              value={path}
              placeholder="qingcode.db 路径"
              onChange={(event) => setPath(event.target.value)}
            />
            <button className="qn-button-subtle shrink-0" type="button" onClick={() => void pickFile()}>
              另选文件
            </button>
          </div>
          <p className="mt-1 text-[11px] text-qn-muted">
            旧版可能正在运行，导入会先复制数据库再只读打开，不会改动原文件。
          </p>
        </div>

        <div className="rounded border border-qn-border bg-black/20 p-3">
          <div className="mb-2 text-xs text-qn-muted">预览数量</div>
          {counts ? (
            <div className="grid grid-cols-2 gap-2 text-xs">
              <span>SSH 连接：{counts.connections}</span>
              <span>本机项目：{counts.localProjects}</span>
              <span>远端项目：{counts.sshProjects}</span>
              <span>已保存密码：{counts.secrets}</span>
            </div>
          ) : (
            <div className="text-xs text-qn-muted">{busy ? '正在检测…' : '未检测到旧版数据'}</div>
          )}
        </div>

        <div className="space-y-1">
          <Checkbox checked={includeSecrets} onChange={setIncludeSecrets}>
            同时导入已保存的密码 / 口令
          </Checkbox>
          <p className="pl-5 text-[11px] leading-5 text-qn-muted">
            用本机系统加密重新保存（Windows DPAPI），不勾选则只导入连接与项目。
          </p>
        </div>

        {busy && <Spinner label="正在导入，请稍候…" />}
        <ErrorNote message={error} onRetry={() => void runImport()} />

        {result && (
          <div className="space-y-2 rounded border border-emerald-400/30 bg-emerald-400/5 p-3 text-xs">
            <div className="font-medium text-emerald-300">导入完成</div>
            <div className="grid grid-cols-2 gap-1">
              <span>连接：{result.imported.targets}</span>
              <span>项目：{result.imported.projects}</span>
              <span>主机指纹：{result.imported.hostKeys}</span>
              <span>密码：{result.imported.secrets}</span>
            </div>
            {result.skipped.length > 0 && (
              <div className="pt-1">
                <div className="mb-1 text-qn-muted">跳过 {result.skipped.length} 项：</div>
                <ul className="max-h-32 space-y-1 overflow-y-auto">
                  {result.skipped.map((item, index) => (
                    <li key={`${item.kind}-${item.name}-${index}`} className="flex gap-2">
                      <X size={11} className="mt-0.5 shrink-0 text-qn-danger" />
                      <span className="min-w-0 flex-1">
                        [{item.kind}] {item.name}：{item.reason}
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
