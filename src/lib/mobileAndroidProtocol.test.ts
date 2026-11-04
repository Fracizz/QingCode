import { describe, expect, it } from 'vitest'
import { buildPairingLink, formatFingerprint } from './mobilePairing'
// Android WebView 资产与桌面共用同一套配对链接格式。
import {
  MODIFIER_LOCK_WINDOW,
  PULL_MAX,
  PULL_THRESHOLD,
  applyModifiers,
  avatarFor,
  consumeModifier,
  keySequence,
  matchesProject,
  launchCommand,
  nextModifierState,
  outputBatches,
  outputChunk,
  parsePairingLink,
  projectSourceLabel,
  recentProjects,
  rememberProject,
  pullOffset,
  renameProfileKeys,
  splitInput,
} from '../../mobile/android/web/protocol.js'

const fingerprint = '0123456789abcdef'.repeat(4)

describe('Android recent projects', () => {
  it('orders phone and desktop opens by time and caps the result at ten', () => {
    const projects = Array.from({ length: 15 }, (_, i) => ({ id: String(i), lastOpenedAt: i + 1 }))
    const result = recentProjects(projects, [{ id: '0', openedAt: 30 }, { id: 'removed', openedAt: 100 }])
    expect(result.map(item => item.id)).toEqual(['0', '14', '13', '12', '11', '10', '9', '8', '7', '6'])
    expect(projects[0].id).toBe('0')
  })

  it('handles older desktops and damaged history without inventing opens', () => {
    const projects = [{ id: 'old' }, { id: 'new', lastOpenedAt: 20 }, { id: 'invalid', lastOpenedAt: NaN }]
    expect(recentProjects(projects, null).map(item => item.id)).toEqual(['new'])
    expect(recentProjects(projects, [null, { id: 'old', openedAt: 30 }, { id: 'new', openedAt: 'bad' }])
      .map(item => item.id)).toEqual(['old', 'new'])
  })

  it('moves reopened projects to the top and bounds persisted history', () => {
    let history = null
    for (let i = 0; i < 15; i++) history = rememberProject(history, String(i), i + 1)
    history = rememberProject(history, '8', 30)
    expect(history).toHaveLength(10)
    expect(history[0]).toEqual({ id: '8', openedAt: 30 })
    expect(history.filter(item => item.id === '8')).toHaveLength(1)
  })
})

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
    expect(matchesProject({ name: 'app', kind: 'ssh' }, 'app')).toBe(true)
  })

  it('searches connection names, addresses and paths in a single project list', () => {
    for (const query of [' wSl ', 'LOCALHOST', '/home/code/django', 'django']) {
      expect(matchesProject(wslRemote, query)).toBe(true)
    }
    expect(matchesProject(wslRemote, 'WinDev')).toBe(false)
    expect(matchesProject({ ...wslRemote, host: '192.168.252.107' }, '252.107')).toBe(true)
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

  it('merges adjacent byte chunks into one write and keeps snapshots separate', () => {
    // 「中」的 UTF-8 三个字节跨块拆开，合并后仍完整。
    const bytes = new TextEncoder().encode('a中')
    const raw = (part: Uint8Array) => btoa(String.fromCharCode(...part))
    const batches = outputBatches([raw(bytes.slice(0, 2)), raw(bytes.slice(2)), { data: 'snap', cols: 80, rows: 24 }, btoa('b'), btoa('c')])
    expect(batches).toHaveLength(3)
    expect(new TextDecoder().decode(batches[0].data as Uint8Array)).toBe('a中')
    expect(batches[1]).toEqual({ screen: true, data: 'snap', cols: 80, rows: 24 })
    expect(new TextDecoder().decode(batches[2].data as Uint8Array)).toBe('bc')
    expect(outputBatches([])).toEqual([])
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
    expect(keySequence('backspace')).toBe('\x7f')
    expect(keySequence('shift-tab')).toBe('\x1b[Z')
    expect(keySequence('delete-word')).toBe('\x17')
    expect(keySequence('delete-line-start')).toBe('\x15')
    expect(keySequence('newline')).toBe('\n')
    expect(() => keySequence('f1')).toThrow()
  })

  it('moves per-connection records when the address changes', () => {
    const prefix = 'qingcode:mobile:'
    const keys = [
      `${prefix}session:1.2.3.4:48764:p1`,
      `${prefix}project:1.2.3.4:48764`,
      `${prefix}session:1.2.3.4:487640:p1`,
      `${prefix}active`,
      `${prefix}recent-projects:1.2.3.4:48764`,
    ]
    expect(renameProfileKeys(keys, prefix, '1.2.3.4:48764', '1.2.3.4:49000')).toEqual([
      [keys[0], `${prefix}session:1.2.3.4:49000:p1`],
      [keys[1], `${prefix}project:1.2.3.4:49000`],
      [keys[4], `${prefix}recent-projects:1.2.3.4:49000`],
    ])
  })
})

describe('Android extra-key modifiers (Termux-style lock)', () => {
  it('cycles off → once → lock on a double tap and releases on the next tap', () => {
    const first = nextModifierState('off', 1000)
    expect(first).toEqual({ state: 'once', at: 1000 })
    const second = nextModifierState(first.state, 1000 + MODIFIER_LOCK_WINDOW, first.at)
    expect(second.state).toBe('lock')
    expect(nextModifierState(second.state, 5000, second.at).state).toBe('off')
  })

  it('treats a slow second tap as cancelling the one-shot modifier', () => {
    expect(nextModifierState('once', 2000, 2000 - MODIFIER_LOCK_WINDOW - 1).state).toBe('off')
  })

  it('consumes one-shot modifiers but keeps locked ones', () => {
    expect(consumeModifier('once')).toBe('off')
    expect(consumeModifier('off')).toBe('off')
    expect(consumeModifier('lock')).toBe('lock')
  })
})

describe('Android pull to refresh', () => {
  it('ignores upward or zero movement', () => {
    expect(pullOffset(0)).toBe(0)
    expect(pullOffset(-40)).toBe(0)
    expect(pullOffset(Number.NaN)).toBe(0)
  })

  it('damps the pull, crosses the threshold with a deliberate drag and never exceeds the maximum', () => {
    expect(pullOffset(60)).toBeLessThan(60)
    expect(pullOffset(80)).toBeLessThan(PULL_THRESHOLD)
    expect(pullOffset(150)).toBeGreaterThanOrEqual(PULL_THRESHOLD)
    expect(pullOffset(10_000)).toBeLessThanOrEqual(PULL_MAX)
    expect(pullOffset(100)).toBeGreaterThan(pullOffset(90))
  })
})

describe('Android connection avatars', () => {
  it('uses the first character for CJK names and two initials for multi-word names', () => {
    expect(avatarFor('工作电脑').initials).toBe('工')
    expect(avatarFor('build server').initials).toBe('BS')
    expect(avatarFor('DEVBOX').initials).toBe('D')
    expect(avatarFor('').initials).toBe('?')
  })

  it('keeps a stable colour per name within the palette', () => {
    expect(avatarFor('WinDev').hue).toBe(avatarFor('WinDev').hue)
    for (const name of ['a', 'WSL', '工作电脑', 'build server', '🙂 home']) {
      const { hue } = avatarFor(name)
      expect(Number.isInteger(hue) && hue >= 0 && hue < 6).toBe(true)
    }
  })
})
describe('mobile quick launch', () => {
  it('only allows the two fixed commands', () => {
    expect(launchCommand('claude')).toBe('claude\r')
    expect(launchCommand('opencode')).toBe('opencode\r')
    expect(() => launchCommand('claude; rm -rf /')).toThrow()
  })
})
