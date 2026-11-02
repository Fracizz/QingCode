import { Terminal as HeadlessTerminal } from '@xterm/headless'
import { SerializeAddon } from '@xterm/addon-serialize'
import { Unicode11Addon } from '@xterm/addon-unicode11'

/** 一帧排好的终端屏幕（SerializeAddon 序列化结果）及其网格。 */
export interface TerminalViewSnapshot {
  data: string
  cols: number
  rows: number
}

/** store 持有后台屏幕所需的最小接口（store 不直接依赖 headless xterm）。 */
export interface TerminalBackgroundScreenHandle {
  write(data: Uint8Array | string): void
  capture(): Promise<TerminalViewSnapshot | null>
  dispose(): void
}

/**
 * 视图卸载后继续维护的后台屏幕，相当于 Server daemon 里 vt100 的前端版本：
 * 本地、SSH、Server 三种终端统一在这里持续解析输出，重挂时直接导出当前屏幕，
 * 不再受卸载期间输出量的限制，也不用把原始字节按旧网格回放一遍。
 */
export class TerminalBackgroundScreen implements TerminalBackgroundScreenHandle {
  private readonly term: HeadlessTerminal
  private readonly serializer = new SerializeAddon()
  private disposed = false

  constructor(snapshot: TerminalViewSnapshot, scrollback: number) {
    this.term = new HeadlessTerminal({
      cols: snapshot.cols,
      rows: snapshot.rows,
      scrollback,
      allowProposedApi: true,
    })
    // SerializeAddon 同时支持 headless；两边的 Terminal 类型声明不通用，只能断言。
    this.term.loadAddon(this.serializer as unknown as Parameters<HeadlessTerminal['loadAddon']>[0])
    // 与视图保持一致的字符宽度表，否则 CJK / emoji 在后台屏幕里会错列。
    const unicode11 = new Unicode11Addon()
    this.term.loadAddon(unicode11 as unknown as Parameters<HeadlessTerminal['loadAddon']>[0])
    this.term.unicode.activeVersion = '11'
    this.term.write(snapshot.data)
  }

  write(data: Uint8Array | string) {
    if (!this.disposed) this.term.write(data)
  }

  /**
   * 等已写入的字节全部解析后导出屏幕。程序已退出全屏（回到普通缓冲区）时返回
   * `null`：普通缓冲区由 ring 回放即可正确重排，且 ring 里有完整历史。
   */
  capture(): Promise<TerminalViewSnapshot | null> {
    if (this.disposed) return Promise.resolve(null)
    return new Promise(resolve => {
      this.term.write('', () => {
        if (this.disposed || this.term.buffer.active.type !== 'alternate') {
          resolve(null)
          return
        }
        try {
          resolve({
            data: this.serializer.serialize(),
            cols: this.term.cols,
            rows: this.term.rows,
          })
        } catch {
          resolve(null)
        }
      })
    })
  }

  dispose() {
    if (this.disposed) return
    this.disposed = true
    try {
      this.term.dispose()
    } catch {}
  }
}
