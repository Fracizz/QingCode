import { useRef, type ReactNode } from 'react'
import { GitCompareArrows, TriangleAlert } from 'lucide-react'
import { t } from '@qn/codex-client'
import { Modal } from '../../components/ui'
import { MergeEditor } from './editor/MergeEditor'
import type { FilePrompt } from './editModel'
import { useFiles } from './filesStore'

const button = 'rounded-lg px-3 py-1.5 text-ui'

function Footer({ children }: { children: ReactNode }) {
  return <div className="flex flex-wrap items-center justify-end gap-2">{children}</div>
}

function CancelButton() {
  return (
    <button type="button" className={`${button} qn-button-subtle`} onClick={() => useFiles.getState().dismissPrompt()}>
      {t('取消')}
    </button>
  )
}

function CloseDialog({ ids }: { ids: string[] }) {
  const dirty = useFiles((state) => state.tabs.filter((tab) => ids.includes(tab.id) && tab.dirty).length)
  return (
    <Modal
      title={t('未保存的改动')}
      description={dirty > 0 ? t('{count} 个标签有未保存的改动，关闭前请选择。', { count: dirty }) : t('确认关闭这些标签？')}
      onClose={() => useFiles.getState().dismissPrompt()}
      footer={
        <Footer>
          <CancelButton />
          <button type="button" className={`${button} qn-button-subtle`} onClick={() => useFiles.getState().confirmClose(false)}>
            {t('不保存关闭')}
          </button>
          <button type="button" className={`${button} qn-button`} onClick={() => useFiles.getState().confirmClose(true)}>
            {t('保存并关闭')}
          </button>
        </Footer>
      }
    >
      <div className="text-ui leading-6 text-qn-muted">{t('「保存并关闭」会先逐个保存；若遇到冲突，会弹出冲突对话框并保留标签。')}</div>
    </Modal>
  )
}

function RefreshDialog({ id }: { id: string }) {
  const tab = useFiles((state) => state.tabs.find((item) => item.id === id))
  return (
    <Modal
      title={t('刷新会丢弃未保存改动')}
      description={tab?.path}
      onClose={() => useFiles.getState().dismissPrompt()}
      footer={
        <Footer>
          <CancelButton />
          <button type="button" className={`${button} qn-button-subtle`} onClick={() => useFiles.getState().confirmRefresh('discard')}>
            {t('不保存刷新')}
          </button>
          <button type="button" className={`${button} qn-button`} onClick={() => useFiles.getState().confirmRefresh('save')}>
            {t('保存并刷新')}
          </button>
        </Footer>
      }
    >
      <div className="text-ui leading-6 text-qn-muted">{t('刷新会从磁盘重新读取文件内容，当前未保存的编辑不会保留。')}</div>
    </Modal>
  )
}

function ConflictDialog({ prompt }: { prompt: Extract<FilePrompt, { kind: 'conflict' }> }) {
  const tab = useFiles((state) => state.tabs.find((item) => item.id === prompt.id))
  return (
    <Modal
      title={t('保存冲突')}
      description={prompt.message}
      onClose={() => useFiles.getState().resolveConflict('cancel')}
      footer={
        <Footer>
          <CancelButton />
          <button
            type="button"
            className={`${button} qn-button-subtle`}
            onClick={() => useFiles.getState().resolveConflict('reload')}
          >
            {t('重新加载')}
          </button>
          <button
            type="button"
            className={`${button} qn-button-subtle inline-flex items-center gap-1.5 disabled:opacity-50`}
            disabled={prompt.diskText === undefined}
            title={prompt.diskText === undefined ? t('未能读取磁盘内容') : undefined}
            onClick={() => useFiles.getState().resolveConflict('compare')}
          >
            <GitCompareArrows size={13} /> {t('对比')}
          </button>
          <button type="button" className={`${button} qn-button`} onClick={() => useFiles.getState().resolveConflict('overwrite')}>
            {t('覆盖')}
          </button>
        </Footer>
      }
    >
      <div className="flex flex-col gap-2 text-ui leading-6 text-qn-muted">
        <div className="flex items-start gap-2 rounded-lg border border-qn-warn/30 bg-qn-warn/10 px-3 py-2 text-qn-warn">
          <TriangleAlert size={15} className="mt-1 shrink-0" />
          <span>{t('磁盘上的版本与打开时不同（可能由 Agent 或其他编辑器修改）。')}</span>
        </div>
        <div className="truncate font-mono text-ui-sm text-qn-dim">{tab?.path}</div>
        <div>{t('· 覆盖：不带 mtime 检查直接写入本地内容')}</div>
        <div>{t('· 重新加载：丢弃本地改动，读回磁盘版本')}</div>
        <div>{t('· 对比：左本地、右磁盘，逐块采纳后再保存')}</div>
      </div>
    </Modal>
  )
}

function CompareDialog({ prompt }: { prompt: Extract<FilePrompt, { kind: 'compare' }> }) {
  const tab = useFiles((state) => state.tabs.find((item) => item.id === prompt.id))
  const merged = useRef(prompt.disk)
  const saving = tab?.saving ?? false
  return (
    <Modal
      title={t('合并本地与磁盘内容')}
      description={t('左：本地改动　右：磁盘内容；点击中间箭头逐块采纳左侧内容，也可直接编辑右侧。')}
      width="max-w-5xl"
      bodyClassName="overflow-hidden"
      onClose={() => useFiles.getState().dismissPrompt()}
      footer={
        <Footer>
          <CancelButton />
          <button
            type="button"
            className={`${button} qn-button`}
            disabled={saving}
            onClick={() => void useFiles.getState().saveCompare(prompt.id, merged.current)}
          >
            {saving ? t('保存中…') : t('保存合并结果')}
          </button>
        </Footer>
      }
    >
      <div className="flex h-[min(56vh,460px)] flex-col overflow-hidden rounded-lg border border-qn-border bg-qn-code">
        <div className="flex shrink-0 items-center gap-4 border-b border-qn-border px-3 py-1 text-ui-xs text-qn-muted">
          <span className="flex-1 truncate">{t('左 · 本地改动（只读）')}</span>
          <span className="flex-1 truncate">{t('右 · 磁盘内容（可编辑，保存这一侧）')}</span>
        </div>
        <MergeEditor
          original={prompt.local}
          modified={prompt.disk}
          path={tab?.path ?? ''}
          layout="side"
          editableB
          revertControls="a-to-b"
          onModifiedChange={(text) => { merged.current = text }}
          className="min-h-0 flex-1"
        />
      </div>
    </Modal>
  )
}

/** 面板内的所有编辑态对话框；由 FilePane 挂载。 */
export function FileDialogs() {
  const prompt = useFiles((state) => state.prompt)
  if (!prompt) return null
  switch (prompt.kind) {
    case 'close':
      return <CloseDialog key={`close-${prompt.ids.join(',')}`} ids={prompt.ids} />
    case 'refresh':
      return <RefreshDialog key={`refresh-${prompt.id}`} id={prompt.id} />
    case 'conflict':
      return <ConflictDialog key={`conflict-${prompt.id}`} prompt={prompt} />
    case 'compare':
      return <CompareDialog key={`compare-${prompt.id}`} prompt={prompt} />
  }
}
