import { useEffect, useState } from 'react'
import { t, translateMessage, type FileRewindResult } from '@qn/codex-client'
import { friendlyError } from '../lib/errors'
import { useCodex } from '../store/codex'
import type { AgentKind } from '../../../shared/backendApi'
import { LoadingIcon } from './LoadingIcon'
import { ErrorNote, Modal } from './ui'

type Phase =
  | { step: 'checking' }
  | { step: 'preview'; preview: FileRewindResult }
  | { step: 'applying'; preview: FileRewindResult }
  | { step: 'done'; result: FileRewindResult }
  | { step: 'failed'; message: string }

/** 先 dryRun 列出将改动的文件，用户点确认后才真正回滚。 */
export function RewindDialog({ chat, turnId, onClose }: {
  chat: { targetId: string; agent: AgentKind; threadId: string }
  turnId: string
  onClose: () => void
}) {
  const rewind = useCodex((s) => s.rewindFiles)
  const [phase, setPhase] = useState<Phase>({ step: 'checking' })
  const [attempt, setAttempt] = useState(0)
  const { targetId, agent, threadId } = chat

  useEffect(() => {
    let current = true
    setPhase({ step: 'checking' })
    rewind({ targetId, agent, threadId }, turnId, true).then(
      (preview) => { if (current) setPhase({ step: 'preview', preview }) },
      (error: unknown) => { if (current) setPhase({ step: 'failed', message: friendlyError(error, t('无法检查可回滚的文件')) }) },
    )
    return () => { current = false }
  }, [rewind, targetId, agent, threadId, turnId, attempt])

  const apply = async (preview: FileRewindResult) => {
    setPhase({ step: 'applying', preview })
    try {
      setPhase({ step: 'done', result: await rewind(chat, turnId, false) })
    } catch (error) {
      setPhase({ step: 'failed', message: friendlyError(error, t('回滚文件失败')) })
    }
  }

  const preview = phase.step === 'preview' || phase.step === 'applying' ? phase.preview : null
  const confirmable = !!preview?.canRewind && preview.filesChanged.length > 0
  const busy = phase.step === 'applying'

  return (
    <Modal
      title={t('回滚文件到此轮开始前')}
      description={t('只回滚 Write/Edit/NotebookEdit 造成的部分改动，Bash 与子代理改动基本不回滚，对话不回退。')}
      // 回滚执行中不允许关闭，避免看不到结果。
      onClose={busy ? undefined : onClose}
      footer={
        <div className="flex justify-end gap-2">
          {phase.step === 'done' ? (
            <button type="button" className="qn-button" onClick={onClose}>{t('关闭')}</button>
          ) : (
            <>
              <button type="button" className="qn-button-subtle" disabled={busy} onClick={onClose}>{t('取消')}</button>
              {phase.step === 'failed' ? (
                <button type="button" className="qn-button" onClick={() => setAttempt((value) => value + 1)}>{t('重新检查')}</button>
              ) : (
                <button
                  type="button"
                  className="qn-button bg-qn-danger hover:bg-qn-danger disabled:opacity-40"
                  disabled={!confirmable || busy}
                  onClick={() => { if (preview) void apply(preview) }}
                >
                  {busy ? t('正在回滚…') : t('确认回滚')}
                </button>
              )}
            </>
          )}
        </div>
      }
    >
      {phase.step === 'checking' && (
        <p role="status" className="flex items-center gap-2 text-qn-muted"><LoadingIcon size={14} /> {t('正在检查将改动的文件…')}</p>
      )}
      {phase.step === 'failed' && <ErrorNote message={phase.message} />}
      {preview && (
        <div className="space-y-2">
          {!preview.canRewind ? (
            <p role="alert" className="text-qn-warn">
              {t('无法回滚：{reason}', { reason: preview.error ? translateMessage(preview.error) : t('没有可用的文件检查点') })}
            </p>
          ) : preview.filesChanged.length === 0 ? (
            <p className="text-qn-muted">{t('没有需要回滚的文件。')}</p>
          ) : (
            <>
              <p>
                {t('将改动 {count} 个文件', { count: preview.filesChanged.length })}
                <span className="ml-2 font-mono text-ui-sm text-qn-muted">+{preview.insertions} −{preview.deletions}</span>
              </p>
              <ul className="qn-scroll max-h-56 overflow-auto rounded-lg border border-qn-border bg-qn-inset px-2 py-1.5 font-mono text-ui-sm leading-5">
                {preview.filesChanged.map((path) => <li key={path} className="wrap-anywhere">{path}</li>)}
              </ul>
            </>
          )}
          {preview.canRewind && preview.error && (
            <p role="alert" className="text-qn-warn">{t('部分内容不会回滚：{reason}', { reason: translateMessage(preview.error) })}</p>
          )}
        </div>
      )}
      {phase.step === 'done' && (
        phase.result.canRewind ? (
          <div className="space-y-2">
            <p role="status">{t('文件已回滚，对话保持不变。')}</p>
            {phase.result.error && (
              <p role="alert" className="text-qn-warn">{t('部分内容未回滚：{reason}', { reason: translateMessage(phase.result.error) })}</p>
            )}
          </div>
        ) : (
          <p role="alert" className="text-qn-danger">
            {t('回滚未完成：{reason}', { reason: phase.result.error ? translateMessage(phase.result.error) : t('没有可用的文件检查点') })}
          </p>
        )
      )}
    </Modal>
  )
}
