import { describe, expect, it } from 'vitest'
import { closeTab, createTab, type Tab } from './filesModel'
import {
  applyDiskText,
  applyLocalEdit,
  detectEol,
  isDirty,
  markDiskChanged,
  markSaveFailed,
  markSaved,
  markSaving,
  planConflict,
  readOnlyLabel,
  readOnlyReason,
  toDiskText,
  toEditorText,
} from './editModel'

const fileTab = (overrides: Partial<Tab> = {}): Tab => ({
  ...createTab({ kind: 'file', targetId: 'local', path: '/repo/a.ts' }, 'f1'),
  status: 'ready',
  content: 'one\ntwo\n',
  savedText: 'one\ntwo\n',
  mtimeMs: 100,
  ...overrides,
})

describe('换行检测与还原', () => {
  it('按多数换行决定 CRLF / LF', () => {
    expect(detectEol('a\nb\n')).toBe('\n')
    expect(detectEol('a\r\nb\r\n')).toBe('\r\n')
    expect(detectEol('a\r\nb\nc\n')).toBe('\n')
    expect(detectEol('a\r\nb\r\nc\n')).toBe('\r\n')
    expect(detectEol('no newline')).toBe('\n')
  })

  it('编辑器文本统一 \\n，写盘还原原换行', () => {
    expect(toEditorText('a\r\nb\r\n')).toBe('a\nb\n')
    expect(toDiskText('a\nb\n', '\n')).toBe('a\nb\n')
    expect(toDiskText('a\nb\n', '\r\n')).toBe('a\r\nb\r\n')
    expect(toDiskText('a\r\nb\n', '\r\n')).toBe('a\r\nb\r\n')
    expect(toDiskText(toEditorText('x\r\ny\r\n'), detectEol('x\r\ny\r\n'))).toBe('x\r\ny\r\n')
  })
})

describe('dirty 与只读判定', () => {
  it('content 与 savedText 不等即 dirty', () => {
    expect(isDirty(fileTab())).toBe(false)
    expect(isDirty(fileTab({ content: 'changed' }))).toBe(true)
  })

  it('二进制 / 图片 / 未完整加载 / diff 标签只读', () => {
    expect(readOnlyReason(fileTab())).toBe(null)
    expect(readOnlyReason(fileTab({ binary: true }))).toBe('binary')
    expect(readOnlyReason(fileTab({ path: '/repo/logo.PNG' }))).toBe('image')
    expect(readOnlyReason(fileTab({ truncated: true }))).toBe('truncated')
    expect(readOnlyReason(createTab({ kind: 'diff', targetId: 'local', path: '/repo/a.ts', cwd: '/repo' }, 'd1'))).toBe('diff')
    expect(readOnlyLabel('truncated')).toContain('只读')
    expect(readOnlyLabel(null)).toBe('')
  })
})

describe('标签状态迁移', () => {
  it('编辑 → 保存 → 磁盘变更 → 重新加载', () => {
    const initial = fileTab({ eol: '\r\n' })
    const saving = markSaving(initial)
    expect(saving).toMatchObject({ saving: true, saveError: undefined })

    const edited = applyLocalEdit(saving, 'one\ntwo\nthree\n')
    expect(edited).toMatchObject({ dirty: true, saveError: undefined })

    const saved = markSaved(edited, 200)
    expect(saved).toMatchObject({ dirty: false, mtimeMs: 200, saving: false, diskChanged: false, savedText: 'one\ntwo\nthree\n' })

    const changed = markDiskChanged(saved)
    expect(changed.diskChanged).toBe(true)
    expect(markDiskChanged(changed)).toBe(changed)

    const reloaded = applyDiskText(changed, 'disk\r\nversion\r\n', 300)
    expect(reloaded).toMatchObject({
      content: 'disk\nversion\n',
      savedText: 'disk\nversion\n',
      eol: '\r\n',
      mtimeMs: 300,
      dirty: false,
      diskChanged: false,
      saving: false,
    })
  })

  it('保存期间继续输入时只记已写盘的那份文本，dirty 保持为 true', () => {
    const started = markSaving(fileTab())
    const typedMore = applyLocalEdit(started, 'one\ntwo\nmore\n')
    const saved = markSaved(typedMore, 200, 'one\ntwo\n')
    expect(saved).toMatchObject({ savedText: 'one\ntwo\n', dirty: true, mtimeMs: 200 })
    expect(isDirty(saved)).toBe(true)
  })

  it('保存失败写中文提示；重新编辑清除提示', () => {
    const failed = markSaveFailed(fileTab(), '保存失败：磁盘已满')
    expect(failed).toMatchObject({ saving: false, saveError: '保存失败：磁盘已满' })
    expect(applyLocalEdit(failed, 'x').saveError).toBeUndefined()
  })

  it('编辑回已保存文本自动取消 dirty；关闭脏标签后 activeId 迁移', () => {
    const edited = applyLocalEdit(fileTab(), 'changed')
    expect(applyLocalEdit(edited, fileTab().content).dirty).toBe(false)
    const tabs = [edited, fileTab({ id: 'f2', path: '/repo/b.ts' })]
    expect(closeTab(tabs, 'f1', 'f1')).toMatchObject({ activeId: 'f2' })
  })
})

describe('冲突决策', () => {
  const ctx = { local: 'local\ntext\n', eol: '\r\n' as const, diskText: 'disk\r\nversion\r\n' }

  it('覆盖写出还原 CRLF 的本地文本且不带 mtime 检查', () => {
    expect(planConflict('overwrite', ctx)).toEqual({ kind: 'overwrite', content: 'local\r\ntext\r\n' })
  })

  it('重新加载 / 取消只给动作', () => {
    expect(planConflict('reload', ctx)).toEqual({ kind: 'reload' })
    expect(planConflict('cancel', ctx)).toEqual({ kind: 'cancel' })
  })

  it('对比把两侧都归一为编辑器换行；磁盘内容缺失时为空', () => {
    expect(planConflict('compare', ctx)).toEqual({ kind: 'compare', local: 'local\ntext\n', disk: 'disk\nversion\n' })
    expect(planConflict('compare', { ...ctx, diskText: undefined })).toEqual({
      kind: 'compare',
      local: 'local\ntext\n',
      disk: '',
    })
  })
})
