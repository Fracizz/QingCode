import { createHash, X509Certificate } from 'node:crypto'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { certificateFingerprint, certificateFromPem, loadOrCreateCertificate } from './cert'

const tempDirs: string[] = []

afterAll(async () => {
  for (const dir of tempDirs.splice(0)) {
    await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
  }
})

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'qn-mobile-cert-'))
  tempDirs.push(dir)
  return dir
}

describe('手机网关证书', () => {
  it('指纹是 DER 的 SHA-256，而不是 PEM 文本哈希', async () => {
    const dir = await tempDir()
    const certificate = await loadOrCreateCertificate(dir, { commonName: 'localhost' })
    const pemBody = certificate.cert
      .replace(/-----BEGIN CERTIFICATE-----|-----END CERTIFICATE-----|\s/g, '')
    const expected = createHash('sha256')
      .update(Buffer.from(pemBody, 'base64'))
      .digest('hex')
    expect(certificateFingerprint(certificate.cert)).toBe(expected)
    expect(certificate.fingerprint).toMatch(/^[0-9a-f]{64}$/)
    expect(expected).not.toBe(createHash('sha256').update(certificate.cert).digest('hex'))
    expect(() => certificateFingerprint('not a certificate')).toThrow()
    expect(certificateFromPem(certificate.cert, 'not a key')).toBeNull()

    const x509 = new X509Certificate(certificate.cert)
    const years = (Date.parse(x509.validTo) - Date.parse(x509.validFrom)) / (365 * 24 * 3600 * 1000)
    expect(years).toBeGreaterThan(9.9)
    expect(years).toBeLessThan(10.1)
  })

  it('首次持久化，读取时复用；显式重新生成才更换证书', async () => {
    const dir = await tempDir()
    const first = await loadOrCreateCertificate(dir, { commonName: 'localhost' })
    const certFile = await readFile(join(dir, 'cert.pem'), 'utf8')
    const keyFile = await readFile(join(dir, 'key.pem'), 'utf8')
    expect(certFile).toBe(first.cert)
    expect(keyFile).toContain('PRIVATE KEY')

    const reused = await loadOrCreateCertificate(dir, { commonName: 'localhost' })
    expect(reused.fingerprint).toBe(first.fingerprint)

    const replaced = await loadOrCreateCertificate(dir, {
      replace: true,
      commonName: 'localhost',
    })
    expect(replaced.fingerprint).not.toBe(first.fingerprint)
    expect(replaced.fingerprint).toMatch(/^[0-9a-f]{64}$/)
    expect(await loadOrCreateCertificate(dir, { commonName: 'localhost' }))
      .toMatchObject({ fingerprint: replaced.fingerprint })
  })
})
