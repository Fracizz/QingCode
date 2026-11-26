import { describe, expect, it } from 'vitest'
import {
  attachmentsBlocking,
  basename,
  buildUserInput,
  dirname,
  filterSlashItems,
  formatBytes,
  isImageFile,
  pathSeparator,
  sanitizeFileName,
  slashQuery,
  splitUserText,
  uploadPath,
  type Attachment,
  type SlashItem,
} from './attachments'

describe('附件基础', () => {
  it('识别图片', () => {
    expect(isImageFile({ name: 'a.png', type: 'image/png' })).toBe(true)
    expect(isImageFile({ name: 'a.JPG', type: '' })).toBe(true)
    expect(isImageFile({ name: 'a.svg', type: 'image/svg+xml' })).toBe(false)
    expect(isImageFile({ name: 'a.txt', type: 'text/plain' })).toBe(false)
  })

  it('格式化大小', () => {
    expect(formatBytes(512)).toBe('512 B')
    expect(formatBytes(1536)).toBe('1.5 KB')
    expect(formatBytes(3 * 1024 * 1024)).toBe('3 MB')
  })

  it('清洗文件名', () => {
    expect(sanitizeFileName('a/b\\c:d*e?.log')).toBe('a_b_c_d_e_.log')
    expect(sanitizeFileName('...')).toBe('file')
    expect(sanitizeFileName(' 报告.pdf ')).toBe('报告.pdf')
  })

  it('按 home 写法拼上传路径', () => {
    const now = new Date(2026, 10, 26)
    expect(pathSeparator('C:\\Users\\a')).toBe('\\')
    expect(pathSeparator('/root')).toBe('/')
    expect(uploadPath('/root/', 'a b.txt', now, 'x1')).toBe('/root/.qingcode-next/uploads/20261126/x1-a b.txt')
    expect(uploadPath('C:\\Users\\a', 'r.log', now, 'x1')).toBe('C:\\Users\\a\\.qingcode-next\\uploads\\20261126\\x1-r.log')
    expect(dirname('/root/x/y.txt')).toBe('/root/x')
    expect(basename('C:\\a\\b.png')).toBe('b.png')
  })
})

describe('buildUserInput', () => {
  const image: Attachment = { id: '1', kind: 'image', name: 'a.png', size: 1, dataUrl: 'data:image/png;base64,AA' }
  const ready: Attachment = { id: '2', kind: 'file', name: 'a.log', size: 1, localPath: '', targetPath: '/t/a.log', status: 'ready' }
  const failed: Attachment = { id: '3', kind: 'file', name: 'b.log', size: 1, localPath: '', targetPath: null, status: 'error' }

  it('技能在前，随后文字、图片、文件', () => {
    expect(buildUserInput('看看', [ready, image], { name: 'review', path: '/s/SKILL.md' })).toEqual([
      { type: 'skill', name: 'review', path: '/s/SKILL.md' },
      { type: 'text', text: '看看', text_elements: [] },
      { type: 'image', url: 'data:image/png;base64,AA' },
      { type: 'mention', name: 'a.log', path: '/t/a.log' },
    ])
  })

  it('空白文字不发送，未就绪文件跳过', () => {
    expect(buildUserInput('  ', [image, failed], null)).toEqual([{ type: 'image', url: 'data:image/png;base64,AA' }])
    expect(buildUserInput('', [], null)).toEqual([])
  })

  it('上传中或失败时阻止发送', () => {
    expect(attachmentsBlocking([image, ready])).toBeNull()
    expect(attachmentsBlocking([{ ...ready, status: 'uploading' }])).toBe('附件上传中…')
    expect(attachmentsBlocking([failed])).toMatch(/失败/)
  })
})

describe('斜杠菜单', () => {
  it('只在开头且无空白时进入命令态', () => {
    expect(slashQuery('/', 1)).toBe('')
    expect(slashQuery('/rev', 4)).toBe('rev')
    expect(slashQuery('/rev x', 6)).toBeNull()
    expect(slashQuery('a /rev', 6)).toBeNull()
    expect(slashQuery('/rev', 2)).toBe('r')
  })

  it('按前缀 > 包含 > 描述排序，命令优先', () => {
    const items: SlashItem[] = [
      { id: 's1', kind: 'skill', name: 'review', description: '代码审查' },
      { id: 's2', kind: 'skill', name: 'pre-review', description: '' },
      { id: 's3', kind: 'skill', name: 'deploy', description: '发布前 review' },
      { id: 'c1', kind: 'command', name: 'new', description: '新会话' },
    ]
    expect(filterSlashItems(items, 'rev').map((i) => i.id)).toEqual(['s1', 's2', 's3'])
    expect(filterSlashItems(items, '').map((i) => i.id)).toEqual(['c1', 's3', 's2', 's1'])
    expect(filterSlashItems(items, 'zzz')).toEqual([])
  })
})

describe('splitUserText', () => {
  it('拆出桥接追加的附件说明与技能前缀', () => {
    const text = '/review 看下这个\n\n附件文件（请按需读取）：\n- a.log: /tmp/a.log\n- b c.txt: C:\\x\\b c.txt'
    expect(splitUserText(text)).toEqual({ text: '看下这个', files: ['/tmp/a.log', 'C:\\x\\b c.txt'], skill: 'review' })
  })

  it('普通文字原样返回', () => {
    expect(splitUserText('你好 /tmp 路径')).toEqual({ text: '你好 /tmp 路径', files: [], skill: null })
    expect(splitUserText('/commit-push')).toEqual({ text: '', files: [], skill: 'commit-push' })
  })
})

