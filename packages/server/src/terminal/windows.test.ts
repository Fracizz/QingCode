import { describe, expect, it, vi } from 'vitest'
import { createConPtyBackend } from './windows'

const options = {
  shell: 'C:/Windows/System32/cmd.exe',
  args: ['/d'],
  cwd: 'C:/work',
  cols: 80,
  rows: 24,
  env: { TERM: 'xterm-256color' },
}

describe('Windows ConPTY 适配', () => {
  it('按 argv 启动并传递字节、尺寸及退出事件', async () => {
    const output: Array<(data: string) => void> = []
    const exits: Array<(exit: { exitCode: number }) => void> = []
    const dispose = vi.fn()
    const native = {
      pid: 42,
      onData(listener: (data: string) => void) {
        output.push(listener)
        return { dispose }
      },
      onExit(listener: (exit: { exitCode: number }) => void) {
        exits.push(listener)
        return { dispose: vi.fn() }
      },
      write: vi.fn(),
      resize: vi.fn(),
      kill: vi.fn(),
    }
    const spawn = vi.fn(() => native)
    const proc = await createConPtyBackend({ spawn }).spawn(options)
    expect(spawn).toHaveBeenCalledWith(options.shell, options.args, {
      cwd: options.cwd,
      cols: 80,
      rows: 24,
      env: options.env,
    })
    expect(proc.pid).toBe(42)
    output[0]?.('命令提示符')
    const data = vi.fn()
    proc.onData(data)
    expect(data).toHaveBeenCalledWith(Buffer.from('命令提示符'))
    const input = Buffer.from([0x03, 0x0d])
    proc.write(input)
    expect(native.write).toHaveBeenCalledWith(input)
    expect(proc.resize(100, 40)).toBe(true)
    expect(native.resize).toHaveBeenCalledWith(100, 40)

    proc.kill()
    proc.kill()
    expect(native.kill).toHaveBeenCalledOnce()
    expect(proc.resize(120, 40)).toBe(false)
    exits[0]?.({ exitCode: 1 })
    const onExit = vi.fn()
    proc.onExit(onExit)
    expect(onExit).toHaveBeenCalledWith({ code: 1, signal: null })
    expect(dispose).toHaveBeenCalledOnce()
  })

  it('启动失败使用固定错误文案，避免带出环境或原生诊断', async () => {
    const backend = createConPtyBackend({
      spawn() {
        throw new Error('native diagnostic')
      },
    })
    await expect(backend.spawn(options)).rejects.toMatchObject({
      code: 'term_spawn_failed',
      message: '无法启动 Windows ConPTY 终端',
    })
  })
})
