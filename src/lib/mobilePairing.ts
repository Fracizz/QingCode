/** 移动端配对链接：Windows 设置页生成二维码，Android 扫码或粘贴后解析（见 mobile/android/web/protocol.js）。 */
export const PAIRING_SCHEME = 'qingcode://pair'

export interface PairingTarget {
  host: string
  port: number
  fingerprint: string
  name: string
  /** 配对密码：只用于「复制连接信息」，二维码和普通配对链接不带密码。 */
  code?: string
}

/** 编码地址、端口、证书指纹和电脑名；给出 code 时附带密码，手机粘贴后可直接配对。 */
export function buildPairingLink({ host, port, fingerprint, name, code }: PairingTarget): string {
  const query = new URLSearchParams({ v: '1', host, port: String(port), fp: fingerprint, name })
  if (code) query.set('code', code)
  return `${PAIRING_SCHEME}?${query.toString()}`
}

/**
 * 「复制连接信息」的完整文本：可读说明 + 含密码的配对链接。
 * 手机端从任意文本中提取 qingcode://pair 链接，经聊天软件转发后多出的前后文字不影响导入。
 */
export function buildConnectionInfo(target: PairingTarget & { code: string }): string {
  return [
    'QingCode 移动连接',
    `电脑：${target.name}`,
    `地址：${target.host}:${target.port}`,
    '在 QingCode Android「添加连接」中点「粘贴配对链接」即可自动导入并配对：',
    buildPairingLink(target),
  ].join('\n')
}

/** 指纹按 4 位分组，便于在两端肉眼核对。 */
export function formatFingerprint(fingerprint: string): string {
  return fingerprint.match(/.{1,4}/g)?.join(' ') ?? fingerprint
}
