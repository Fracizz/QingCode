#!/usr/bin/env node
// 终端输出 IPC 前端开销基准（手动运行，不进 CI）：node scripts/perf/terminal-ipc-frontend.mjs
// 每次处理 1 个 32 KiB 块（与后端 TERMINAL_EMIT_COALESCE_MAX 一致），对比接收端各编码方案的
// 解码开销，并以 xterm 解析同一块数据（不含渲染）作参照，判断 IPC 编码是否是瓶颈。
// 注意：在 Node/V8 中测得，WebView2 同为 V8，量级可比；不含 eval/fetch 的跨进程投递开销。
import { JSDOM } from 'jsdom'
import { decodeTerminalEventData } from '../../src/utils/terminalIpc.ts'

const CHUNK = 32 * 1024
const TOTAL_MB = Number(process.env.BENCH_MB ?? 128)
const rounds = Math.round((TOTAL_MB * 1024 * 1024) / CHUNK)
const line =
  '\x1b[32m   Compiling\x1b[0m qingcode v1.2.3 (D:\\code\\qingcode\\src-tauri) 构建日志 \x1b[1;33mwarning\x1b[0m: unused variable `x`\r\n'

const encodedLine = new TextEncoder().encode(line)
const chunk = new Uint8Array(CHUNK)
for (let i = 0; i < CHUNK; i += encodedLine.length) {
  chunk.set(encodedLine.subarray(0, Math.min(encodedLine.length, CHUNK - i)), i)
}
const base64 = Buffer.from(chunk).toString('base64')
// 当前事件负载：WebView 把 serde_json 输出当脚本字面量解析，近似 JSON.parse。
const eventJson = JSON.stringify({ event: 'terminal-data', payload: { id: 'terminal-0123456789', data: base64 } })
// Channel<Vec<u8>> 默认序列化：JSON 数字数组。
const numberArrayJson = JSON.stringify({ id: 'terminal-0123456789', data: Array.from(chunk) })

const results = []
async function measure(name, fn) {
  for (let i = 0; i < Math.min(200, rounds); i += 1) await fn() // 预热，触发 JIT
  const start = process.hrtime.bigint()
  for (let i = 0; i < rounds; i += 1) await fn()
  const secs = Number(process.hrtime.bigint() - start) / 1e9
  results.push({ name, mbPerSec: TOTAL_MB / secs, usPerChunk: (secs * 1e6) / rounds })
}

let sink = 0
await measure('当前: 解析事件 JSON + base64 解码', () => {
  sink ^= decodeTerminalEventData(JSON.parse(eventJson).payload.data).length
})
await measure('  其中仅 base64 解码 (atob 循环)', () => {
  sink ^= decodeTerminalEventData(base64).length
})
if (typeof Uint8Array.fromBase64 === 'function') {
  await measure('  候选: Uint8Array.fromBase64', () => {
    sink ^= Uint8Array.fromBase64(base64).length
  })
}
await measure('Channel<Vec<u8>>: 解析数字数组 JSON', () => {
  sink ^= decodeTerminalEventData(JSON.parse(numberArrayJson).data).length
})
await measure('Raw ArrayBuffer: 仅拷贝 (不含 fetch)', () => {
  sink ^= decodeTerminalEventData(new Uint8Array(chunk.buffer.slice(0))).length
})

// xterm 需要 DOM；只 new 不 open，测纯解析 + 缓冲区写入。
const dom = new JSDOM('<!doctype html><html><body></body></html>', { pretendToBeVisual: true })
for (const key of ['window', 'document', 'navigator', 'HTMLElement', 'HTMLCanvasElement', 'MutationObserver', 'getComputedStyle', 'requestAnimationFrame', 'cancelAnimationFrame']) {
  if (!(key in globalThis) || key === 'window' || key === 'document') {
    Object.defineProperty(globalThis, key, { value: dom.window[key], configurable: true, writable: true })
  }
}
dom.window.HTMLCanvasElement.prototype.getContext = () => null
const xtermModule = await import('@xterm/xterm')
const Terminal = xtermModule.Terminal ?? xtermModule.default.Terminal
const term = new Terminal({ cols: 120, rows: 30, scrollback: 5000, allowProposedApi: true })
// 连续入队后只等最后一个回调，避免每块等待 xterm 的定时调度而测成计时器延迟。
// xterm 积压超过 50 MB 会丢数据，按 4 MB 一批入队。
async function writeAll(count) {
  for (let done = 0; done < count; ) {
    const batch = Math.min(128, count - done)
    for (let i = 0; i < batch - 1; i += 1) term.write(chunk)
    await new Promise(resolve => term.write(chunk, resolve))
    done += batch
  }
}
await writeAll(200)
{
  const start = process.hrtime.bigint()
  await writeAll(rounds)
  const secs = Number(process.hrtime.bigint() - start) / 1e9
  results.push({ name: '参照: xterm.write 解析 (不含渲染)', mbPerSec: TOTAL_MB / secs, usPerChunk: (secs * 1e6) / rounds })
}

console.log(`Node ${process.version}，块大小 ${CHUNK / 1024} KiB，总量 ${TOTAL_MB} MB，样本为带 ANSI 颜色的构建日志`)
for (const r of results) {
  console.log(`${r.name.padEnd(36)} ${r.mbPerSec.toFixed(0).padStart(7)} MB/s  ${r.usPerChunk.toFixed(1).padStart(8)} us/块`)
}
if (sink === 0.5) console.log(sink)
term.dispose()
dom.window.close()
