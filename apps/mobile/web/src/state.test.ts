import { describe, expect, it } from 'vitest'
import type { ApprovalView } from '@qn/codex-client'
import {
  applyTargetState,
  availableApprovalDecisions,
  buildMobileTurnInput,
  cleanThreadText,
  formatTurnError,
  connectionRepairReason,
  draftKey,
  errorCode,
  formatQuotedMessage,
  formatTime,
  friendlyError,
  HOST_KEY_HINT,
  hostKeyMessage,
  isHostKeyError,
  joinPath,
  mobileApprovalReply,
  parentPath,
  parseConnections,
  parseDrafts,
  parseProjects,
  parseSavedChats,
  parseTargets,
  projectsForTarget,
  quoteText,
  serializeConnections,
  targetStatus,
  toThreadSummaries,
} from './state'

const FP = 'cd'.repeat(32)

describe('parseTargets / parseProjects', () => {
  it('归一化目标并保证本机在首位', () => {
    const targets = parseTargets([
      { id: 'ssh-1', kind: 'ssh', name: '93', host: '192.168.10.93', port: 22, username: 'root', auth: { kind: 'privateKey', keyPath: 'C:\\keys\\id' } },
      { id: 'local', kind: 'local', name: '本机' },
      { id: 'bad', kind: 'weird', name: 'x' },
      null,
    ])
    expect(targets.map((item) => item.id)).toEqual(['local', 'ssh-1'])
    expect(targets[1]).toMatchObject({ kind: 'ssh', auth: { kind: 'agent' } })
    expect(parseTargets({ data: [] })).toEqual([])
  })

  it('透传电脑上是否已保存密码', () => {
    const targets = parseTargets([
      { id: 'a', kind: 'ssh', name: 'a', host: 'h', port: 22, username: 'u', auth: { kind: 'password' }, hasSavedSecret: true },
      { id: 'b', kind: 'ssh', name: 'b', host: 'h', port: 22, username: 'u', auth: { kind: 'password' } },
    ])
    expect(targets[0]).toMatchObject({ hasSavedSecret: true })
    expect(targets[1]).not.toHaveProperty('hasSavedSecret')
  })

  it('保留电脑已有的直连目标和地址，丢弃不需要的授权字段', () => {
    expect(parseTargets([
      { id: 'direct-a', kind: 'direct', name: '直连工作机', host: 'fd00::1', port: 47390, fingerprint: FP },
      { id: 'direct-b', kind: 'direct', name: '无效目标', host: 'host', port: 65536 },
    ])).toEqual([{ id: 'direct-a', kind: 'direct', name: '直连工作机', host: 'fd00::1', port: 47390 }])
  })

  it('解析 key 认证与秒/毫秒时间戳', () => {
    const targets = parseTargets([
      { id: 'k', kind: 'ssh', name: 'k', host: 'h', port: 2222, username: 'u', auth: { kind: 'key', keyPath: '/k' } },
    ])
    expect(targets[0]).toMatchObject({ auth: { kind: 'key', keyPath: '/k' } })

    const projects = parseProjects([
      { id: 'p1', targetId: 'local', name: '', path: 'D:\\code\\a', lastOpenedAt: 1_700_000_000 },
      { id: 'p2', targetId: 'local', name: 'b', path: '/root/b', lastOpenedAt: 1_700_000_000_000 },
      { id: 'p3', targetId: 'ssh-1', name: 'c', path: '/c', lastOpenedAt: 0 },
    ])
    expect(projects[0]?.name).toBe('a')
    expect(projects[0]?.lastOpenedAt).toBe(1_700_000_000_000)
    expect(projectsForTarget(projects, 'local').map((item) => item.id)).toEqual(['p1', 'p2'])
  })
})

describe('applyTargetState / targetStatus', () => {
  it('只接受合法状态并保留 detail', () => {
    const empty = {}
    const next = applyTargetState(empty, { id: 'local', state: 'ready' })
    expect(next).toEqual({ local: { id: 'local', state: 'ready' } })
    expect(empty).toEqual({})
    const failed = applyTargetState(next, { id: 'local', state: 'error', detail: 'ssh 失败' })
    expect(failed.local).toEqual({ id: 'local', state: 'error', detail: 'ssh 失败' })
    expect(targetStatus(failed, 'local')).toBe('error')
    expect(targetStatus(failed, 'other')).toBe('idle')
    expect(applyTargetState(next, { id: 'x', state: 'unknown' })).toBe(next)
    expect(applyTargetState(next, null)).toBe(next)
  })
})

describe('parseConnections', () => {
  it('往返序列化并丢弃非法项', () => {
    const raw = serializeConnections([
      { id: 'a', name: '电脑', host: '192.168.1.2', port: 38500, fp: FP, token: 'tok', desktopName: 'PC', createdAt: 1 },
      { id: 'bad', name: '', host: 'bad host', port: 38500, fp: FP, token: 'tok', desktopName: '', createdAt: 0 },
      { id: 'no-token', name: '', host: 'h', port: 38500, fp: FP, token: '', desktopName: '', createdAt: 0 },
    ])
    const parsed = parseConnections(raw)
    expect(parsed).toHaveLength(1)
    expect(parsed[0]).toMatchObject({ id: 'a', host: '192.168.1.2', port: 38500, fp: FP })
    expect(parseConnections('not json')).toEqual([])
    expect(parseConnections(null)).toEqual([])
  })
})

describe('toThreadSummaries / formatTime', () => {
  it('按创建时间倒序（缺失时退回更新时间），兼容秒级时间戳', () => {
    const summaries = toThreadSummaries({
      data: [
        { id: 'old', preview: '第一行\n第二行', cwd: '/a', updatedAt: 1_600_000_000 },
        { id: 'new', preview: 'new', name: '命名会话', cwd: '/b', updatedAt: 1_700_000_000_000 },
        // 恢复会话会刷新 updatedAt；排序以 recencyAt 为准，不能因为点开过就排到最前。
        { id: 'opened', preview: 'opened', cwd: '/c', updatedAt: 1_800_000_000, recencyAt: 1_500_000_000 },
      ],
    })
    expect(summaries.map((item) => item.id)).toEqual(['new', 'old', 'opened'])
    expect(summaries[1]?.title).toBe('第一行')
    // 有创建时间时按创建时间排序，最近活动时间不影响顺序。
    const created = toThreadSummaries({
      data: [
        { id: 'first', preview: 'a', createdAt: 1_600_000_000, updatedAt: 1_900_000_000 },
        { id: 'second', preview: 'b', createdAt: 1_700_000_000, updatedAt: 1_700_000_000 },
      ],
    })
    expect(created.map((item) => item.id)).toEqual(['second', 'first'])
    expect(created[1]?.createdAt).toBe(1_600_000_000_000)
    expect(formatTime(0)).toBe('—')
    expect(formatTime(1_700_000_000_000)).not.toBe('—')
  })
})

describe('错误信息', () => {
  it('SSH 主机指纹错误提示到电脑确认，证书指纹不匹配不当作 SSH 指纹', () => {
    expect(hostKeyMessage({ code: 'hostKey', message: '指纹变化' }, '连接失败')).toBe(HOST_KEY_HINT)
    expect(hostKeyMessage({ message: 'known_hosts 中不存在该主机' }, '连接失败')).toBe(HOST_KEY_HINT)
    expect(hostKeyMessage({ code: 'fingerprint', message: '证书已重新生成' }, '连接失败')).toBe('证书已重新生成')
    expect(isHostKeyError({ message: '密码错误' })).toBe(false)
    expect(friendlyError({ error: '网络错误' }, '兜底')).toBe('网络错误')
    expect(friendlyError(new Error('x'), '兜底')).toBe('x')
    expect(friendlyError(null, '兜底')).toBe('兜底')
    expect(errorCode({ code: 'unauthorized' })).toBe('unauthorized')
  })
})

describe('目录路径', () => {
  it('Windows 与 POSIX 的上一级、拼接', () => {
    expect(parentPath('D:\\code\\qingcode-next')).toBe('D:\\code')
    expect(parentPath('D:\\code')).toBe('D:\\')
    expect(parentPath('/root/srv')).toBe('/root')
    expect(parentPath('/root')).toBe('/')
    expect(parentPath('C:')).toBeNull()
    expect(joinPath('D:\\code', 'a')).toBe('D:\\code\\a')
    expect(joinPath('/root/', 'a')).toBe('/root/a')
    expect(joinPath('', 'a')).toBe('a')
  })
})

describe('注释拼接（§12）', () => {
  it('引用逐行加前缀、评论可空、多注释之间空行', () => {
    expect(quoteText('a\nb')).toBe('> a\n> b')
    expect(formatQuotedMessage([], '用户消息')).toBe('用户消息')
    expect(formatQuotedMessage([{ id: '1', quote: 'a\nb', comment: '' }], '用户消息')).toBe(
      '> a\n> b\n\n用户消息',
    )
    expect(
      formatQuotedMessage(
        [
          { id: '1', quote: 'x', comment: '请看这里' },
          { id: '2', quote: 'y', comment: '' },
        ],
        '  请修复  ',
      ),
    ).toBe('> x\n请看这里\n\n> y\n\n请修复')
  })
})

describe('会话恢复、草稿和审批', () => {
  it('会话键包含电脑、目标、项目、Agent、会话，恢复时过滤非法记录', () => {
    const key = draftKey('一号电脑', 'local', 'project', 'codex', 'thread')
    expect(draftKey('二号电脑', 'local', 'project', 'codex', 'thread')).not.toBe(key)
    const annotation = { id: '1', quote: '原文', comment: '评论' }
    expect(parseDrafts(JSON.stringify({
      [key]: { text: '草稿', annotations: [annotation, { id: 'bad' }] },
      wrong: { text: 1, annotations: [] },
    }))).toEqual({ [key]: { text: '草稿', annotations: [annotation] } })
    const chat = { targetId: 'local', projectId: 'project', threadId: 'thread', agent: 'claude' }
    expect(parseSavedChats(JSON.stringify({ ok: chat, bad: { ...chat, agent: 'wrong' } }))).toEqual({ ok: chat })
  })

  it('只有电脑授权或证书错误需要重新配对', () => {
    expect(connectionRepairReason({ code: 'unauthorized' })).toBe('unauthorized')
    expect(connectionRepairReason('设备已被撤销')).toBe('unauthorized')
    expect(connectionRepairReason({ code: 'fingerprint' })).toBe('fingerprint')
    expect(connectionRepairReason({ code: 'hostKey', message: '请在电脑上确认主机指纹' })).toBeNull()
  })

  it('审批保留原生支持的决策，未知请求没有可伪造的许可信号', () => {
    const request: ApprovalView = {
      requestId: 1, threadId: 't', title: '审批', detail: '', kind: 'command',
      method: 'item/commandExecution/requestApproval',
      raw: { params: { availableDecisions: ['accept', 'decline', 'cancel'] } },
    }
    expect(availableApprovalDecisions(request, 'codex')).toEqual(['accept', 'decline', 'cancel'])
    expect(availableApprovalDecisions({ ...request, method: 'item/tool/requestUserInput' }, 'codex')).toEqual([])
    expect(availableApprovalDecisions(request, 'pi')).toEqual([])
    const legacy = { ...request, method: 'applyPatchApproval', raw: {} }
    expect(availableApprovalDecisions(legacy, 'codex')).toEqual(['accept', 'acceptForSession', 'decline', 'cancel'])
    expect(mobileApprovalReply(legacy, 'cancel')).toEqual({ decision: 'abort' })
    expect(availableApprovalDecisions({ ...request, raw: { params: { availableDecisions: ['accept'] } } }, 'codex')).toEqual([])
  })

  it('Codex 的工作区文件引用附到正文，图片与资源引用仍是原生输入', () => {
    const file = { type: 'mention', name: 'main.ts', path: '/repo/main.ts' } as const
    const resource = { type: 'mention', name: 'plugin', path: 'plugin://demo' } as const
    const image = { type: 'image', url: 'data:image/png;base64,AA==' } as const
    expect(buildMobileTurnInput('codex', '你好', [file, resource, image])).toEqual([
      { type: 'text', text: '你好\n\n附件文件（请按需读取）：\n- main.ts: /repo/main.ts', text_elements: [] },
      resource, image,
    ])
    expect(buildMobileTurnInput('claude', '', [file])).toEqual([file])
  })

  it('技能放在正文之前，只有技能也能组成输入', () => {
    const skill = { type: 'skill', name: 'pdf', path: '/skills/pdf/SKILL.md' } as const
    const image = { type: 'image', url: 'data:image/png;base64,AA==' } as const
    expect(buildMobileTurnInput('claude', '整理', [image, skill])).toEqual([
      skill, { type: 'text', text: '整理', text_elements: [] }, image,
    ])
    expect(buildMobileTurnInput('codex', '', [skill])).toEqual([skill])
  })
})

describe('formatTurnError', () => {
  it('从 429 JSON 中提取说明', () => {
    const view = formatTurnError('429: {"code":null,"message":"usage limit reached","type":"rate_limit_error"}')
    expect(view).toEqual({ title: '已达用量上限或请求过多（429）', detail: 'usage limit reached' })
  })
  it('嵌套 error.message 与非 JSON 正文', () => {
    expect(formatTurnError('401 {"error":{"message":"bad key"}}').detail).toBe('bad key')
    expect(formatTurnError('503: upstream down')).toEqual({ title: '模型服务暂时不可用（503）', detail: 'upstream down' })
  })
  it('认不出格式时保留原文', () => {
    expect(formatTurnError('2026年配额用尽')).toEqual({ title: '本轮失败', detail: '2026年配额用尽' })
  })
})

describe('formatTurnError Claude 格式', () => {
  it('识别 API Error 中的状态码', () => {
    expect(formatTurnError('API Error: Request rejected (429) · usage limit reached')).toEqual({
      title: '已达用量上限或请求过多（429）', detail: 'usage limit reached',
    })
  })
})

describe('cleanThreadText', () => {
  it('还原 Claude 斜杠命令标记，去掉其它标签', () => {
    expect(cleanThreadText('<command-name>/clear</command-name>\n<command-message>clear</command-message>\n<command-args></command-args>')).toBe('/clear')
    expect(cleanThreadText('<command-name>/review</command-name><command-args>PR 12</command-args>')).toBe('/review PR 12')
    expect(cleanThreadText('<local-command-stdout>ok</local-command-stdout>')).toBe('ok')
    expect(cleanThreadText('a < b 且 c > d')).toBe('a < b 且 c > d')
  })
})
