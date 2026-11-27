import { describe, expect, it } from 'vitest'
import { parseArgs } from './args'
import { candidateHosts, parseListen } from './serve'

describe('serve / direct 参数', () => {
  it('解析监听地址', () => {
    expect(parseListen('47390')).toEqual({ host: '0.0.0.0', port: 47390 })
    expect(parseListen(':47390')).toEqual({ host: '0.0.0.0', port: 47390 })
    expect(parseListen('127.0.0.1:1')).toEqual({ host: '127.0.0.1', port: 1 })
    expect(parseListen('[::1]:8080')).toEqual({ host: '::1', port: 8080 })
    expect(() => parseListen('host')).toThrow()
    expect(() => parseListen('0.0.0.0:70000')).toThrow()
  })

  it('候选地址：通配监听时列出外部 IPv4，具体地址只给它', () => {
    const ifaces = {
      lo: [{ address: '127.0.0.1', family: 'IPv4', internal: true }],
      eth0: [
        { address: '192.168.10.87', family: 'IPv4', internal: false },
        { address: 'fe80::1', family: 'IPv6', internal: false },
      ],
    } as never
    expect(candidateHosts('0.0.0.0', ifaces)).toEqual(['192.168.10.87'])
    expect(candidateHosts('10.0.0.5', ifaces)).toEqual(['10.0.0.5'])
  })

  it('命令行：serve 必须带 --listen，且 --listen 只能用于 serve / direct enable', () => {
    expect(parseArgs(['serve', '--listen', '47390'])).toMatchObject({ command: 'serve', listen: '47390' })
    expect(parseArgs(['serve', '--listen=0.0.0.0:1', '--state-dir', 'x'])).toMatchObject({ listen: '0.0.0.0:1', stateDir: 'x' })
    expect(() => parseArgs(['serve'])).toThrow()
    expect(() => parseArgs(['daemon', '--listen', '1'])).toThrow()
  })

  it('命令行：direct 子命令与各自允许的开关', () => {
    expect(parseArgs(['direct', 'enable', '--listen', '47390', '--allow-public'])).toMatchObject({
      command: 'direct',
      action: 'enable',
      listen: '47390',
      allowPublic: true,
    })
    expect(parseArgs(['direct', 'grant', '--name', 'pc', '--host', 'a', '--host=b'])).toMatchObject({
      action: 'grant',
      name: 'pc',
      hosts: ['a', 'b'],
    })
    expect(parseArgs(['direct', 'revoke', '--id', 'abc'])).toMatchObject({ action: 'revoke', id: 'abc' })
    expect(parseArgs(['direct', 'status'])).toMatchObject({ action: 'status' })
    expect(() => parseArgs(['direct'])).toThrow()
    expect(() => parseArgs(['direct', 'enable'])).toThrow()
    expect(() => parseArgs(['direct', 'revoke'])).toThrow()
    expect(() => parseArgs(['direct', 'grant', '--listen', '1'])).toThrow()
    expect(() => parseArgs(['direct', 'status', '--allow-public'])).toThrow()
  })
})
