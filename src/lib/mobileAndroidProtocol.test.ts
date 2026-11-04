import { describe, expect, it } from 'vitest'
import { buildPairingLink, formatFingerprint } from './mobilePairing'
// Android WebView 资产与桌面共用同一套配对链接格式。
import {
  applyModifiers,
  keySequence,
  matchesProject,
  outputChunk,
  parsePairingLink,
  projectSourceLabel,
  renameProfileKeys,
  splitInput,
} from '../../mobile/android/web/protocol.js'

const fingerprint = '0123456789abcdef'.repeat(4)

describe('Android project sources', () => {
  const wslRemote = {
    name: 'django', kind: 'ssh', path: 'ssh://wsl-connection/home/code/django',
    host: 'localhost', connectionName: 'WSL',
  }

  it('distinguishes remote projects by connection name and host', () => {
    expect(projectSourceLabel(wslRemote)).toBe('远端 · WSL · localhost')
    expect(projectSourceLabel({ ...wslRemote, connectionName: 'WinDev', host: '192.168.252.107' }))
      .toBe('远端 · WinDev · 192.168.252.107')
    expect(projectSourceLabel({ kind: 'wsl', host: 'Ubuntu' })).toBe('WSL · Ubuntu')
    expect(projectSourceLabel({ kind: 'local', host: 'Windows' })).toBe('本机')
  })

  it('supports an older desktop without connection names', () => {
    expect(projectSourceLabel({ kind: 'ssh', host: '192.168.252.107' })).toBe('远端 · 192.168.252.107')
    expect(matchesProject({ name: 'app', kind: 'ssh' }, 'all', 'app')).toBe(true)
  })

  it('searches connection names, addresses and paths without changing the transport category', () => {
    for (const query of [' wSl ', 'LOCALHOST', '/home/code/django', 'django']) {
      expect(matchesProject(wslRemote, 'ssh', query)).toBe(true)
    }
    expect(matchesProject(wslRemote, 'wsl', 'WSL')).toBe(false)
    expect(matchesProject(wslRemote, 'all', 'WinDev')).toBe(false)
    expect(matchesProject({ ...wslRemote, host: '192.168.252.107' }, 'all', '252.107')).toBe(true)
  })
})

describe('Android pairing link', () => {
  it('round-trips the desktop link including unicode computer names', () => {
    const link = buildPairingLink({ host: '192.168.1.8', port: 48764, fingerprint, name: '工作 PC&1' })
    expect(parsePairingLink(link)).toEqual({ host: '192.168.1.8', port: 48764, fingerprint, name: '工作 PC&1' })
    expect(parsePairingLink(link.replace(fingerprint, fingerprint.toUpperCase())).fingerprint).toBe(fingerprint)
  })

  it('rejects foreign links and invalid fields', () => {
    expect(() => parsePairingLink('https://example.com')).toThrow('不是 QingCode 配对链接')
    expect(() => parsePairingLink(`qingcode://pair?v=2&host=1.2.3.4&port=1&fp=${fingerprint}`)).toThrow('版本')
    for (const host of ['1.2.3', '256.1.1.1', '01.2.3.4', 'example.com']) {
      expect(() => parsePairingLink(`qingcode://pair?v=1&host=${host}&port=48764&fp=${fingerprint}`)).toThrow('地址')
    }
    expect(() => parsePairingLink(`qingcode://pair?v=1&host=1.2.3.4&port=70000&fp=${fingerprint}`)).toThrow('地址')
    expect(() => parsePairingLink('qingcode://pair?v=1&host=1.2.3.4&port=1&fp=abc')).toThrow('指纹')
  })

  it('groups fingerprints for visual comparison', () => {
    expect(formatFingerprint('abcdef012345')).toBe('abcd ef01 2345')
  })
})

describe('Android terminal protocol', () => {
  it('decodes byte chunks and passes screen snapshots through as text', () => {
    const bytes = outputChunk(btoa('hi\r\n'))
    expect(bytes.screen).toBe(false)
    expect(Array.from(bytes.data as Uint8Array)).toEqual([104, 105, 13, 10])
    // 屏幕快照含原始 ESC 序列；按 base64 解码会抛错并让轮询卡死。
    expect(outputChunk({ data: '\x1b[2Jprompt$ ', cols: 80, rows: 24 })).toEqual({
      screen: true, data: '\x1b[2Jprompt$ ', cols: 80, rows: 24,
    })
  })

  it('splits input without breaking surrogate pairs', () => {
    const text = 'a'.repeat(3) + '😀' + 'b'
    const parts = splitInput(text, 4)
    expect(parts.join('')).toBe(text)
    expect(parts[0]).toBe('aaa')
    expect(parts[1].startsWith('😀')).toBe(true)
    expect(splitInput('')).toEqual([])
  })

  it('maps one-shot Ctrl and Alt modifiers', () => {
    expect(applyModifiers('c', { ctrl: true })).toBe('\x03')
    expect(applyModifiers('[', { ctrl: true })).toBe('\x1b')
    expect(applyModifiers(' ', { ctrl: true })).toBe('\x00')
    expect(applyModifiers('?', { ctrl: true })).toBe('\x7f')
    expect(applyModifiers('b', { alt: true })).toBe('\x1bb')
    expect(applyModifiers('x', { ctrl: true, alt: true })).toBe('\x1b\x18')
    expect(applyModifiers('ab', { ctrl: true })).toBe('ab')
  })

  it('emits cursor and paging sequences in both cursor modes', () => {
    expect(keySequence('up')).toBe('\x1b[A')
    expect(keySequence('up', { applicationCursor: true })).toBe('\x1bOA')
    expect(keySequence('home')).toBe('\x1b[H')
    expect(keySequence('end', { applicationCursor: true })).toBe('\x1bOF')
    expect(keySequence('pgup')).toBe('\x1b[5~')
    expect(keySequence('pgdn', { applicationCursor: true })).toBe('\x1b[6~')
    expect(keySequence('esc')).toBe('\x1b')
    expect(() => keySequence('f1')).toThrow()
  })

  it('moves per-connection records when the address changes', () => {
    const prefix = 'qingcode:mobile:'
    const keys = [
      `${prefix}session:1.2.3.4:48764:p1`,
      `${prefix}project:1.2.3.4:48764`,
      `${prefix}session:1.2.3.4:487640:p1`,
      `${prefix}active`,
    ]
    expect(renameProfileKeys(keys, prefix, '1.2.3.4:48764', '1.2.3.4:49000')).toEqual([
      [keys[0], `${prefix}session:1.2.3.4:49000:p1`],
      [keys[1], `${prefix}project:1.2.3.4:49000`],
    ])
  })
})
