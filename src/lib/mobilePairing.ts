/** 移动端配对链接：Windows 设置页生成二维码，Android 扫码或粘贴后解析（见 mobile/android/web/protocol.js）。 */
export const PAIRING_SCHEME = 'qingcode://pair'

export interface PairingTarget {
  host: string
  port: number
  fingerprint: string
  name: string
}

/** 只编码地址、端口、证书指纹和电脑名；密码不进二维码，仍需在手机上手动输入。 */
export function buildPairingLink({ host, port, fingerprint, name }: PairingTarget): string {
  const query = new URLSearchParams({ v: '1', host, port: String(port), fp: fingerprint, name })
  return `${PAIRING_SCHEME}?${query.toString()}`
}

/** 指纹按 4 位分组，便于在两端肉眼核对。 */
export function formatFingerprint(fingerprint: string): string {
  return fingerprint.match(/.{1,4}/g)?.join(' ') ?? fingerprint
}
