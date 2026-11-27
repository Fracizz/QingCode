// Node 侧提示的实际翻译抽查：嵌套、拼接和易被短模板抢先匹配的句子。
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { addEnglishMessages, setLocale, translateMessage } from '../../../protocol/src/i18n'
import node from './node.en'

const cjk = /[一-鿿　-〿＀-￯]/

describe('node.en 词典', () => {
  beforeAll(() => {
    addEnglishMessages(node)
    setLocale('en')
  })
  afterAll(() => setLocale('zh'))

  it('每条词条都不会被别的模板抢先匹配', () => {
    const wrong = Object.entries(node).flatMap(([source, english]) => {
      const fill = (text: string) => text.replace(/\{(\w+)\}/g, (_all, name: string) => `<${name}>`)
      // 译文可改占位符位置，两边按各自名字填同一批样本值。
      const actual = translateMessage(fill(source))
      return actual === fill(english) ? [] : [{ source, actual }]
    })
    expect(wrong).toEqual([])
  })

  it.each([
    [
      'SSH 认证失败；请确认 ssh-agent 已运行（Windows 管道 \\\\.\\pipe\\openssh-ssh-agent）：All configured authentication methods failed',
      'SSH authentication failed; make sure ssh-agent is running (Windows pipe \\\\.\\pipe\\openssh-ssh-agent): All configured authentication methods failed',
    ],
    [
      'SSH 认证失败；请检查密码、私钥文件与口令：denied',
      'SSH authentication failed; check the password, private key file and passphrase: denied',
    ],
    [
      'SSH 更新未完成（SSH 连接失败：ECONNRESET），正在尝试直连',
      'SSH update did not finish (SSH connection failed: ECONNRESET); trying a direct connection',
    ],
    [
      'SSH 更新未完成（SSH 更新或连接超时），已通过直连连接',
      'SSH update did not finish (SSH update or connection timed out); connected directly instead',
    ],
    [
      'SSH 更新未完成（SSH 更新或连接超时），直连也失败（连接 10.0.0.2:7000 超时）',
      'SSH update did not finish (SSH update or connection timed out); the direct connection also failed (Connection to 10.0.0.2:7000 timed out)',
    ],
    [
      '直连不可用（连接 host:1 失败: ECONNREFUSED），改用 SSH',
      'Direct connection unavailable (Connection to host:1 failed: ECONNREFUSED); switching to SSH',
    ],
    ['远端命令失败（退出码 2）', 'Remote command failed (exit code 2)'],
    ['远端命令失败（退出码 2）：sh: not found', 'Remote command failed (exit code 2): sh: not found'],
    [
      '远端命令失败（退出码 1）：qn-server: daemon 启动超时',
      'Remote command failed (exit code 1): qn-server: Timed out starting the daemon',
    ],
    [
      '本机 daemon 启动失败 (退出码 1): qn-server: 旧版 Server 仍在运行，强制更新未完成',
      'Failed to start the local daemon (exit code 1): qn-server: The old Server is still running. The forced update did not finish',
    ],
    ['本机 daemon 启动失败 (退出码 null)', 'Failed to start the local daemon (exit code null)'],
    ['上传 Node 运行时失败：EPIPE', 'Failed to upload the Node runtime: EPIPE'],
    [
      'python3 PTY 桥不可用：未找到 python3',
      'The python3 PTY bridge is unavailable: python3 not found',
    ],
    [
      'script 兜底不可用：需要 util-linux script',
      'The script fallback is unavailable: requires util-linux script',
    ],
    [
      '别名，由 Claude 自身配置解析；最轻量，适合快速、简单任务',
      'Alias resolved by your Claude configuration; Lightest, for quick and simple tasks',
    ],
    ['Claude 切换推理强度失败，消息未发送', 'Claude failed to switch the reasoning effort. The message was not sent'],
    ['未知命令: (空)', 'Unknown command: (empty)'],
    [
      '不支持的图片类型 (空)，仅支持 png/jpeg/gif/webp',
      'Unsupported image type (empty). Only png/jpeg/gif/webp are supported',
    ],
    ['不支持的图片类型 (无扩展名)：/tmp/a', 'Unsupported image type (no extension): /tmp/a'],
    [
      '未找到 claude (/opt/claude)；请在目标机安装并登录 Claude Code，或用 claudePath 指定可执行文件',
      'claude not found (/opt/claude). Install and sign in to Claude Code on the target, or set the executable with claudePath',
    ],
    ['backend 只能是 auto、python、script、conpty', 'backend must be auto, python, script or conpty'],
    ['task.os.linux.type 只能是 command、ps1、bat、sh、script', 'task.os.linux.type must be command, ps1, bat, sh or script'],
    ['task.os.linux.cwd 必须是字符串', 'task.os.linux.cwd must be a string'],
    ['git 命令失败（退出码 未知）', 'git command failed (unknown exit code)'],
    ['codex app-server 已退出（退出码 3）', 'codex app-server has exited (exit code 3)'],
    ['pi-rpc 未运行', 'pi-rpc is not running'],
    [
      'QingCode Next 手机连接\n电脑：未命名电脑\n地址：192.168.1.2:38500\n在 QingCode Next 手机版「添加连接」中粘贴即可导入：\nqingcode-next://pair?v=1',
      'QingCode Next mobile connection\nComputer: Unnamed computer\nAddress: 192.168.1.2:38500\nPaste into "Add connection" in QingCode Next mobile to import:\nqingcode-next://pair?v=1',
    ],
  ])('翻译 %s', (source, english) => {
    expect(translateMessage(source)).toBe(english)
  })

  it('过宽的句式不登记模板，未知中文原样返回', () => {
    for (const message of ['这个任务已退出', '服务未运行', '输入非法', '未找到相关结果', '地址：北京']) {
      expect(translateMessage(message)).toBe(message)
    }
  })

  it('译文不含中文或全角标点', () => {
    // 省略号与破折号是通用标点，不在检查范围。
    expect(Object.values(node).filter((english) => cjk.test(english))).toEqual([])
  })
})
