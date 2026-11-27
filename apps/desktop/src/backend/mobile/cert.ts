import { createHash, X509Certificate } from 'node:crypto'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { generate } from 'selfsigned'

export type MobileCertificate = {
  cert: string
  key: string
  fingerprint: string
}

export type CertificateGenerator = typeof generate

export type LoadCertificateOptions = {
  replace?: boolean
  commonName?: string
  generate?: CertificateGenerator
  now?: () => Date
}

const TEN_YEARS_MS = 10 * 365 * 24 * 60 * 60 * 1000

/** 指纹是证书 DER 的 SHA-256，而不是 PEM 文本或 selfsigned 自带的字段。 */
export function certificateFingerprint(certPem: string): string {
  return createHash('sha256').update(new X509Certificate(certPem).raw).digest('hex')
}

export function certificateFromPem(certPem: string, keyPem: string): MobileCertificate | null {
  try {
    if (!/-----BEGIN (?:PRIVATE KEY|EC PRIVATE KEY|RSA PRIVATE KEY)-----/.test(keyPem)) return null
    return { cert: certPem, key: keyPem, fingerprint: certificateFingerprint(certPem) }
  } catch {
    return null
  }
}

async function writeAtomic(file: string, content: string, mode: number): Promise<void> {
  const tmp = `${file}.tmp`
  await writeFile(tmp, content, { encoding: 'utf8', mode })
  await rename(tmp, file)
}

/** 证书只在首次使用或用户明确要求重新生成时更换，手机端据此做长期指纹固定。 */
export async function loadOrCreateCertificate(
  directory: string,
  options: LoadCertificateOptions = {}
): Promise<MobileCertificate> {
  await mkdir(directory, { recursive: true })
  const certFile = join(directory, 'cert.pem')
  const keyFile = join(directory, 'key.pem')

  if (!options.replace) {
    try {
      const [cert, key] = await Promise.all([
        readFile(certFile, 'utf8'),
        readFile(keyFile, 'utf8'),
      ])
      const existing = certificateFromPem(cert, key)
      if (existing) return existing
    } catch {
      // 文件缺失或损坏时重新生成，旧证书不能继续用于指纹固定。
    }
  }

  const now = options.now?.() ?? new Date()
  const pems = await (options.generate ?? generate)(
    [{ name: 'commonName', value: options.commonName?.trim() || 'qingcode-next' }],
    {
      keyType: 'ec',
      curve: 'P-256',
      algorithm: 'sha256',
      notBeforeDate: new Date(now.getTime() - 60_000),
      notAfterDate: new Date(now.getTime() + TEN_YEARS_MS),
      extensions: [
        { name: 'basicConstraints', cA: false },
        { name: 'keyUsage', digitalSignature: true },
        { name: 'extKeyUsage', serverAuth: true },
        {
          name: 'subjectAltName',
          altNames: [
            { type: 2, value: 'localhost' },
            { type: 7, ip: '127.0.0.1' },
            { type: 7, ip: '::1' },
          ],
        },
      ],
    }
  )
  const created = certificateFromPem(pems.cert, pems.private)
  if (!created) throw new Error('生成的手机网关证书无效')
  await Promise.all([
    writeAtomic(certFile, created.cert, 0o600),
    writeAtomic(keyFile, created.key, 0o600),
  ])
  return created
}
