// @vitest-environment jsdom
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createFileBrowser } from '../../mobile/android/web/fileBrowser.js'
import { createFilePositions, FILE_SORT_KEY, formatFileBytes, LARGE_FILE_BYTES, needsDownloadConfirmation, readFileSort, relativeFilePath, sortFileEntries } from '../../mobile/android/web/fileBrowserState.js'

const element = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id)! as T
const input = (id: string, value: string) => {
  element<HTMLInputElement>(id).value = value
  element(id).dispatchEvent(new Event('input', { bubbles: true }))
}
const flush = async () => { for (let index = 0; index < 8; index += 1) await Promise.resolve() }
const pending = <T,>() => {
  let complete!: (value: T) => void
  const promise = new Promise<T>(resolve => { complete = resolve })
  return { promise, complete }
}
const host = { id: 'pc:48764', name: 'PC' }
const project = { id: 'p1', name: '项目一' }
const file = { name: 'readme.md', path: 'docs/readme.md', isDir: false, size: 12, modifiedAt: null }

beforeEach(() => {
  const memory = new Map<string, string>()
  vi.stubGlobal('localStorage', { getItem: (key: string) => memory.get(key) ?? null, setItem: (key: string, value: string) => memory.set(key, value), removeItem: (key: string) => memory.delete(key) })
  const html = readFileSync(resolve(import.meta.dirname, '../../mobile/android/web/index.html'), 'utf8')
  document.body.innerHTML = /<body>([\s\S]*)<\/body>/.exec(html)![1]
  HTMLDialogElement.prototype.showModal = function () { this.setAttribute('open', '') }
  HTMLDialogElement.prototype.close = function (value = '') {
    this.returnValue = value
    this.removeAttribute('open')
    this.dispatchEvent(new Event('close'))
  }
})
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals() })

function setup(rpc = vi.fn(async (op: string) => op === 'file_download_location' ? 'Download/QingCode' : op === 'file_stat' ? { ...file, version: 'v1' } : { entries: [file], truncated: false })) {
  const browser = createFileBrowser({ rpc, capabilities: async () => ({ features: ['project_files'] }), profile: () => host })
  return { browser, rpc }
}

async function openFile() {
  element('files-list').querySelector<HTMLButtonElement>('[data-path]')!.click()
  await flush()
}

describe('Android project file browsing', () => {
  it('drops a previous project response after switching projects and keeps terminal DOM and draft', async () => {
    const old = pending<{ entries: typeof file[] }>()
    const rpc = vi.fn((op: string, args: { project: string }) => args.project === 'p1' ? old.promise : Promise.resolve({ entries: [{ ...file, name: 'second.txt', path: 'second.txt' }] }))
    const { browser } = setup(rpc)
    element<HTMLTextAreaElement>('compose').value = '保留草稿'
    element('viewport').textContent = 'existing terminal'
    const first = browser.open(project)
    await flush()
    await browser.open({ id: 'p2', name: '项目二' })
    old.complete({ entries: [file] })
    await first
    expect(element('files-list').textContent).toContain('second.txt')
    expect(element('files-list').textContent).not.toContain('readme.md')
    expect(element('viewport').textContent).toBe('existing terminal')
    expect(element<HTMLTextAreaElement>('compose').value).toBe('保留草稿')
  })

  it('cancels a pending query and ignores its late result', async () => {
    vi.useFakeTimers()
    const query = pending<{ entries: typeof file[] }>()
    const rpc = vi.fn((op: string) => op === 'file_search' ? query.promise : Promise.resolve({ entries: [file] }))
    const { browser } = setup(rpc)
    await browser.open(project)
    input('files-query', 'readme')
    await vi.advanceTimersByTimeAsync(300)
    expect(rpc).toHaveBeenLastCalledWith('file_search', expect.objectContaining({ project: 'p1', path: '', query: 'readme', hidden: false }), expect.objectContaining({ signal: expect.any(AbortSignal) }))
    const signal = (rpc.mock.calls.at(-1) as unknown as [string, object, { signal: AbortSignal }])[2].signal
    element('files-cancel-query').click()
    expect(signal.aborted).toBe(true)
    query.complete({ entries: [file] })
    await flush()
    expect(element('files-status').textContent).toBe('已取消查询')
    expect(element('files-list').textContent).toBe('')
  })

  it('shows search truncation and can locate a result in its directory', async () => {
    vi.useFakeTimers()
    const rpc = vi.fn(async () => ({ entries: [file], truncated: true }))
    const { browser } = setup(rpc)
    await browser.open(project)
    input('files-query', 'readme')
    await vi.advanceTimersByTimeAsync(300)
    expect(element('files-truncated').textContent).toContain('200 条')
    element('files-list').querySelector<HTMLButtonElement>('.file-locate')!.click()
    await flush()
    expect(rpc).toHaveBeenLastCalledWith('file_list', expect.objectContaining({ path: 'docs' }), expect.objectContaining({ signal: expect.any(AbortSignal) }))
    expect(element<HTMLInputElement>('files-query').value).toBe('')
  })

  it('requires confirmation for a large file and does not download after declining', async () => {
    const rpc = vi.fn(async (op: string) => op === 'file_stat' ? { ...file, size: LARGE_FILE_BYTES, version: 'v1' } : { entries: [file] })
    const { browser } = setup(rpc)
    await browser.open(project)
    await openFile()
    element('file-download').click()
    await flush()
    expect(element<HTMLDialogElement>('confirm-dialog').open).toBe(true)
    expect(element('confirm-text').textContent).toContain('100 MiB')
    element<HTMLDialogElement>('confirm-dialog').close('cancel')
    await flush()
    expect(rpc.mock.calls.some(([op]) => op === 'file_download')).toBe(false)
    expect(element<HTMLButtonElement>('file-download').disabled).toBe(false)
  })

  it('starts download only for matching stat metadata and shows native progress with cleanup messages', async () => {
    const { browser, rpc } = setup()
    await browser.open(project)
    await openFile()
    element('file-download').click()
    await flush()
    expect(rpc).toHaveBeenCalledWith('file_download', expect.objectContaining({ profile: host.id, project: project.id, path: file.path, version: 'v1' }))
    const receive = (window as unknown as { qingFileDownload: (event: object) => void }).qingFileDownload
    receive({ state: 'downloading', profile: host.id, project: project.id, path: file.path, received: 5, total: 12 })
    expect(element('files-transfer-status').textContent).toBe('已下载 5 B / 12 B')
    receive({ state: 'canceled', profile: host.id, project: project.id, path: file.path, message: '取消，但未完成文件清理失败' })
    expect(element('files-transfer-status').textContent).toContain('清理失败')
    receive({ state: 'done', profile: 'other', project: project.id, path: file.path })
    expect(element('files-transfer-status').textContent).toContain('清理失败')
  })

  it('shows the default directory before downloading and the actual saved filename on completion', async () => {
    const { browser } = setup()
    await browser.open(project)
    await openFile()
    expect(element('file-download-location').textContent).toBe('Download/QingCode')
    element('file-download').click()
    await flush()
    expect(element('files-transfer-status').textContent).toBe('正在准备下载…')
    expect(element<HTMLButtonElement>('files-download-cancel').hidden).toBe(false)
    const receive = (window as unknown as { qingFileDownload: (event: object) => void }).qingFileDownload
    receive({ state: 'done', profile: host.id, project: project.id, path: file.path,
      name: 'readme (1).md', location: 'Download/QingCode/readme (1).md', received: 12, total: 12 })
    expect(element('files-transfer-status').textContent).toBe('下载完成')
    expect(element('files-transfer-name').textContent).toContain('readme (1).md')
    expect(element('files-transfer-location').hidden).toBe(false)
    expect(element('files-transfer-location').textContent).toBe('保存位置：Download/QingCode/readme (1).md')
    expect(element<HTMLButtonElement>('files-download-cancel').hidden).toBe(true)
  })

  it('blocks mismatched file metadata and explains unsupported desktop versions', async () => {
    const { browser } = setup(vi.fn(async (op: string) => op === 'file_stat' ? { ...file, path: 'wrong', version: 'v1' } : { entries: [file] }))
    await browser.open(project)
    await openFile()
    expect(element('file-detail-error').textContent).toContain('文件信息发生变化')
    expect(element<HTMLButtonElement>('file-download').disabled).toBe(true)
    element<HTMLDialogElement>('file-detail-dialog').close()
    element<HTMLDialogElement>('files-dialog').close()
    const rpc = vi.fn()
    const unsupported = createFileBrowser({ rpc, capabilities: async () => null, profile: () => host })
    await unsupported.open(project)
    expect(element('files-status').textContent).toContain('更新电脑端')
    expect(rpc).not.toHaveBeenCalled()
  })
})

describe('file browsing position and size policy', () => {
  it('scopes saved directories to each computer and project and rejects corrupt paths', () => {
    const positions = createFilePositions(localStorage)
    positions.write(host.id, project.id, 'src/lib', 350)
    expect(positions.read(host.id, project.id)).toEqual({ path: 'src/lib', scroll: 350 })
    expect(positions.read('other', project.id)).toEqual({ path: '', scroll: 0 })
    expect(positions.read(host.id, 'other')).toEqual({ path: '', scroll: 0 })
    expect(relativeFilePath('../private')).toBe('')
    expect(relativeFilePath('/etc/passwd')).toBe('')
    expect(relativeFilePath('D:\\secret')).toBe('')
    expect(relativeFilePath('C:secret')).toBe('')
    expect(relativeFilePath('docs/notes:2026.txt')).toBe('docs/notes:2026.txt')
    localStorage.setItem('qingcode:mobile:files:' + host.id + ':' + project.id, '{broken')
    expect(positions.read(host.id, project.id)).toEqual({ path: '', scroll: 0 })
  })

  it('warns at the large file threshold and on unknown sizes without treating empty files as unknown', () => {
    expect(needsDownloadConfirmation(LARGE_FILE_BYTES - 1)).toBe(false)
    expect(needsDownloadConfirmation(LARGE_FILE_BYTES)).toBe(true)
    expect(needsDownloadConfirmation(null)).toBe(true)
    expect(needsDownloadConfirmation(-1)).toBe(true)
    expect(needsDownloadConfirmation(0)).toBe(false)
    expect(formatFileBytes(0)).toBe('0 B')
    expect(formatFileBytes(null)).toBe('大小未知')
    expect(formatFileBytes(1024 ** 3)).toBe('1.0 GiB')
  })
})

describe('file browsing time sort', () => {
  const entries = [
    { name: 'b.txt', path: 'b.txt', isDir: false, modifiedAt: 300 },
    { name: 'old', path: 'old', isDir: true, modifiedAt: 100 },
    { name: 'a.txt', path: 'a.txt', isDir: false, modifiedAt: null },
    { name: 'new', path: 'new', isDir: true, modifiedAt: 200 },
    { name: 'c.txt', path: 'c.txt', isDir: false, modifiedAt: 500 },
  ]

  it('keeps folders first and orders each group by modified time, missing times last', () => {
    expect(sortFileEntries(entries).map(entry => entry.name)).toEqual(['new', 'old', 'c.txt', 'b.txt', 'a.txt'])
    expect(sortFileEntries(entries, 'asc').map(entry => entry.name)).toEqual(['old', 'new', 'b.txt', 'c.txt', 'a.txt'])
    expect(entries[0].name).toBe('b.txt')
  })

  it('defaults to newest first and remembers the toggled direction on the phone', async () => {
    const rpc = vi.fn(async () => ({ entries, truncated: false }))
    const { browser } = setup(rpc)
    await browser.open(project)
    await flush()
    const names = () => [...element('files-list').querySelectorAll<HTMLElement>('[data-path]')].map(row => row.dataset.path)
    expect(names()).toEqual(['new', 'old', 'c.txt', 'b.txt', 'a.txt'])
    expect(element('files-count').textContent).toBe('5 项')
    expect(element('files-status').textContent).toBe('')
    element('files-sort').click()
    expect(names()).toEqual(['old', 'new', 'b.txt', 'c.txt', 'a.txt'])
    expect(element('files-sort').dataset.order).toBe('asc')
    expect(localStorage.getItem(FILE_SORT_KEY)).toBe('asc')
    expect(readFileSort(localStorage)).toBe('asc')
  })
})
