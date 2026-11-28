import { describe, expect, it } from 'vitest'
import {
  attachmentsBlocking,
  basename,
  buildUserInput,
  composeMessageText,
  consumeSlashToken,
  dirname,
  filterSlashItems,
  formatBytes,
  imagePlaceholder,
  insertAtSelection,
  insertImagePlaceholders,
  isImageFile,
  removePlaceholder,
  uniqueImageName,
  pathSeparator,
  sanitizeFileName,
  slashQuery,
  slashToken,
  splitUserText,
  editUserText,
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
    expect(buildUserInput('看看', [ready, image], [{ name: 'review', path: '/s/SKILL.md' }])).toEqual([
      { type: 'skill', name: 'review', path: '/s/SKILL.md' },
      { type: 'text', text: '看看', text_elements: [] },
      { type: 'image', url: 'data:image/png;base64,AA' },
      { type: 'mention', name: 'a.log', path: '/t/a.log' },
    ])
  })

  it('多个技能按选择顺序发送并去重', () => {
    const skills = [
      { name: 'review', path: '/s/review/SKILL.md' },
      { name: 'deploy', path: '/s/deploy/SKILL.md' },
      { name: 'review', path: '/s/review/SKILL.md' },
    ]
    expect(buildUserInput('看看', [], skills).slice(0, 3)).toEqual([
      { type: 'skill', name: 'review', path: '/s/review/SKILL.md' },
      { type: 'skill', name: 'deploy', path: '/s/deploy/SKILL.md' },
      { type: 'text', text: '看看', text_elements: [] },
    ])
  })

  it('空白文字不发送，未就绪文件跳过', () => {
    expect(buildUserInput('  ', [image, failed], [])).toEqual([{ type: 'image', url: 'data:image/png;base64,AA' }])
    expect(buildUserInput('', [], [])).toEqual([])
  })

  it('上传中或失败时阻止发送', () => {
    expect(attachmentsBlocking([image, ready])).toBeNull()
    expect(attachmentsBlocking([{ ...ready, status: 'uploading' }])).toBe('附件上传中…')
    expect(attachmentsBlocking([failed])).toMatch(/失败/)
  })
})

describe('斜杠菜单', () => {
  it('开头或空白后都能进入命令态，光标停在词中间时不进入', () => {
    expect(slashQuery('/', 1)).toBe('')
    expect(slashQuery('/rev', 4)).toBe('rev')
    expect(slashQuery('/rev x', 6)).toBeNull()
    expect(slashQuery('a /rev', 6)).toBe('rev')
    expect(slashQuery('/rev', 2)).toBeNull()
    expect(slashQuery('/a/b', 4)).toBeNull()
  })

  it('能在一条消息里连续选多个技能，只删掉对应的 /片段', () => {
    const first = '帮我 /review 看下 /deploy'
    const token = slashToken(first, 10)
    expect(token).toEqual({ query: 'review', start: 3, end: 10 })
    const afterFirst = consumeSlashToken(first, 10)
    expect(afterFirst).toBe('帮我 看下 /deploy')
    const second = slashToken(afterFirst, afterFirst.length)
    expect(second).toEqual({ query: 'deploy', start: 6, end: afterFirst.length })
    expect(consumeSlashToken(afterFirst, afterFirst.length)).toBe('帮我 看下')
    expect(consumeSlashToken('/review 帮我看看', 7)).toBe('帮我看看')
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
    // Agent 原生命令排在内置命令与技能之间，保持服务端给的顺序。
    const native: SlashItem[] = [
      { id: 'n2', kind: 'native', name: 'review-pr', description: '' },
      { id: 'n1', kind: 'native', name: 'agents', description: '' },
    ]
    expect(filterSlashItems([...items, ...native], '').map((i) => i.id)).toEqual(['c1', 'n2', 'n1', 's3', 's2', 's1'])
  })
})

describe('splitUserText', () => {
  it('编辑 Claude 历史正文时保留技能和附件', () => {
    const original = '/review 看这个\n\n附件文件（请按需读取）：\n- a.log: /tmp/a.log'
    expect(editUserText(original, '先看错误日志')).toBe('/review 先看错误日志\n\n附件文件（请按需读取）：\n- a.log: /tmp/a.log')
  })
  it('拆出桥接追加的附件说明与多个技能前缀', () => {
    const text = '/review /deploy 看下这个\n\n附件文件（请按需读取）：\n- a.log: /tmp/a.log\n- b c.txt: C:\\x\\b c.txt'
    expect(splitUserText(text)).toEqual({
      text: '看下这个',
      files: ['/tmp/a.log', 'C:\\x\\b c.txt'],
      skills: ['review', 'deploy'],
      images: [],
    })
  })

  it('普通文字原样返回', () => {
    expect(splitUserText('你好 /tmp 路径')).toEqual({ text: '你好 /tmp 路径', files: [], skills: [], images: [] })
    expect(splitUserText('/commit-push')).toEqual({ text: '', files: [], skills: ['commit-push'], images: [] })
  })

  it('拆出附图编号与附件说明，编辑时两段都保留', () => {
    const notes = '附图编号（按本条消息中图片的先后顺序）：\n1. [a.png]\n2. [a-2.png]\n\n附件文件（请按需读取）：\n- x.log: /t/x.log'
    const original = `对比 [a.png] 和 [a-2.png]\n\n${notes}`
    expect(splitUserText(original)).toEqual({
      text: '对比 [a.png] 和 [a-2.png]',
      files: ['/t/x.log'],
      skills: [],
      images: ['a.png', 'a-2.png'],
    })
    expect(editUserText(original, '只看 [a-2.png]')).toBe(`只看 [a-2.png]\n\n${notes}`)
  })

  it('格式不符的编号段按用户原文处理', () => {
    const text = '附图编号（按本条消息中图片的先后顺序）：\n随便写的'
    expect(splitUserText(text).text).toBe(text)
  })
})

describe('composeMessageText', () => {
  const image = (id: string, name: string): Attachment => ({ id, kind: 'image', name, size: 1, dataUrl: 'data:image/png;base64,AA' })
  const file: Attachment = { id: 'f', kind: 'file', name: 'x.log', size: 1, localPath: '', targetPath: '/t/x.log', status: 'ready' }

  it('保留占位并按图片发送顺序追加编号', () => {
    expect(composeMessageText('第二张 [image-2.png] 的按钮', [image('1', 'image.png'), image('2', 'image-2.png')])).toBe(
      '第二张 [image-2.png] 的按钮\n\n附图编号（按本条消息中图片的先后顺序）：\n1. [image.png]\n2. [image-2.png]',
    )
  })

  it('没引用图片时不加编号，文件占位原样保留', () => {
    expect(composeMessageText('看 [x.log] 的报错', [file, image('1', 'image.png')])).toBe('看 [x.log] 的报错')
  })

  it('正文只有占位时发空正文，与只发附件一致', () => {
    expect(composeMessageText(' [image.png] [x.log] ', [image('1', 'image.png'), file])).toBe('')
  })
})


describe('输入框图片占位', () => {
  it('重名截图依次编号，无名时用 image.png', () => {
    expect(uniqueImageName('image.png', [])).toBe('image.png')
    expect(uniqueImageName('image.png', ['image.png', 'image-2.png'])).toBe('image-3.png')
    expect(uniqueImageName('', ['image.png'])).toBe('image-2.png')
    expect(uniqueImageName('README', ['README'])).toBe('README-2')
  })

  it('在选区处插入并补空格，光标落在占位之后', () => {
    expect(insertAtSelection('新增 自动', 2, 2, imagePlaceholder('image.png'))).toEqual({
      value: '新增 [image.png] 自动',
      caret: 14,
    })
    expect(insertAtSelection('abc', 1, 2, '[x]')).toEqual({ value: 'a [x] c', caret: 6 })
    expect(insertAtSelection('', 0, 0, '[x]')).toEqual({ value: '[x]', caret: 3 })
  })

  it('移除附件时删掉对应占位', () => {
    expect(removePlaceholder('新增 [image.png] 自动', 'image.png')).toBe('新增 自动')
    expect(removePlaceholder('新增 [image.png]', 'image.png')).toBe('新增')
    expect(removePlaceholder('新增\n[image.png]\n自动', 'image.png')).toBe('新增\n\n自动')
    expect(removePlaceholder('无占位', 'image.png')).toBe('无占位')
  })

  it('按选区放置图片占位，拖入时追加到末尾，多张图片之间有空格', () => {
    expect(insertImagePlaceholders('看这里', ['image.png'], { start: 1, end: 1 })).toEqual({
      value: '看 [image.png] 这里',
      caret: 14,
    })
    expect(insertImagePlaceholders('看图', ['image.png', 'image-2.png']).value).toBe('看图 [image.png] [image-2.png]')
  })

  it('超长文件名在输入框中间省略，重名图片可单独移除，发送使用全名', () => {
    const stem = 'long-file-name-'.repeat(15) + '截图终版'
    const name = `${stem}.png`
    const duplicate = uniqueImageName(`${'long-file-other-'.repeat(15)}same-截图终版.png`, [name])
    const { value } = insertImagePlaceholders('请看图', [name, duplicate])
    expect(value).toBe('请看图 [long-fil…me-截图终版.png] [long-fil…-截图终版-2.png]')
    expect(removePlaceholder(value, duplicate)).toBe('请看图 [long-fil…me-截图终版.png]')
    const attachments = [name, duplicate].map((name, index) => ({
      kind: 'image' as const, id: String(index), name, size: 1, dataUrl: 'data:image/png;base64,AA==',
    }))
    expect(composeMessageText(value, attachments)).toContain(`请看图 [${name}] [${duplicate}]`)
  })

  it('混合粘贴保留文字，只有通过校验的图片才会生成占位', () => {
    const selection = { start: 1, end: 2 }
    expect(insertImagePlaceholders('甲乙丙', ['image.png'], selection, '内容\r\n').value).toBe('甲内容\n[image.png] 丙')
    expect(insertImagePlaceholders('甲乙丙', [], selection, '内容').value).toBe('甲内容丙')
  })
})
