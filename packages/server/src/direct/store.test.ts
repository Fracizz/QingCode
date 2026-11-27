import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  addGrant,
  directFiles,
  hashToken,
  matchGrant,
  parseConfig,
  parseGrants,
  readConfig,
  readGrants,
  removeConfig,
  removeGrant,
  writeConfig,
  type DirectFiles,
} from './store'

let dir: string
let files: DirectFiles

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qn-direct-'))
  files = directFiles(dir)
})

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true })
})

describe('direct config', () => {
  it('round-trips and removes', () => {
    expect(readConfig(files)).toBeNull()
    writeConfig(files, { listen: '0.0.0.0:47390', allowPublic: false })
    expect(readConfig(files)).toEqual({ listen: '0.0.0.0:47390', allowPublic: false })
    removeConfig(files)
    expect(readConfig(files)).toBeNull()
  })

  it('rejects malformed config', () => {
    expect(parseConfig({ listen: '' })).toBeNull()
    expect(parseConfig('x')).toBeNull()
    expect(parseConfig({ listen: '1', allowPublic: 'yes' })).toEqual({ listen: '1', allowPublic: false })
  })
})

describe('direct grants', () => {
  it('stores only token hash and matches the plain token', () => {
    const { grant, token } = addGrant(files, '  my laptop  ', 5)
    expect(grant.name).toBe('my laptop')
    expect(fs.readFileSync(files.grantsFile, 'utf8')).not.toContain(token)
    const grants = readGrants(files)
    expect(grants).toEqual([grant])
    expect(matchGrant(grants, token)?.id).toBe(grant.id)
    expect(matchGrant(grants, 'wrong')).toBeNull()
    expect(matchGrant(grants, undefined)).toBeNull()
  })

  it('revokes by id', () => {
    const a = addGrant(files, 'a')
    const b = addGrant(files, 'b')
    expect(removeGrant(files, a.grant.id)).toBe(true)
    expect(removeGrant(files, a.grant.id)).toBe(false)
    const grants = readGrants(files)
    expect(grants.map((g) => g.id)).toEqual([b.grant.id])
    expect(matchGrant(grants, a.token)).toBeNull()
  })

  it('drops malformed entries', () => {
    expect(parseGrants({ grants: [{ id: 'x', tokenSha256: 'bad' }, { id: 'y', tokenSha256: hashToken('t') }] }))
      .toEqual([{ id: 'y', name: '', tokenSha256: hashToken('t'), createdAt: 0 }])
  })
})
