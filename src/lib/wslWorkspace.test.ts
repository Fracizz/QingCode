import { describe, expect, it } from 'vitest'
import {
  isWslPath,
  isWslProject,
  wslDistroNameFromPath,
  wslDistroPathFromPath,
} from './wslWorkspace'

describe('wslWorkspace', () => {
  describe('isWslPath', () => {
    it('detects Windows WSL UNC paths', () => {
      expect(isWslPath(String.raw`\\wsl$\Ubuntu\home\code\QingCode`)).toBe(true)
      expect(isWslPath(String.raw`\\wsl.localhost\Ubuntu\home\code\QingCode`)).toBe(true)
      expect(isWslPath('//wsl$/Ubuntu/home/code/QingCode')).toBe(true)
      expect(isWslPath('//wsl.localhost/Ubuntu/home/code/QingCode')).toBe(true)
      expect(isWslPath(String.raw`\\WSL$\Ubuntu-22.04\root`)).toBe(true)
      expect(isWslPath(String.raw`\\WSL.LOCALHOST\Debian\var\log`)).toBe(true)
    })

    it('detects wsl:// URI format', () => {
      expect(isWslPath('wsl://Ubuntu/home/code/QingCode')).toBe(true)
      expect(isWslPath('WSL://Ubuntu/home/code/QingCode')).toBe(true)
    })

    it('rejects regular local paths', () => {
      expect(isWslPath('D:/repos/my-app')).toBe(false)
      expect(isWslPath(String.raw`C:\Users\dev\project`)).toBe(false)
      expect(isWslPath('/home/user/project')).toBe(false)
      expect(isWslPath('')).toBe(false)
      expect(isWslPath(null)).toBe(false)
      expect(isWslPath(undefined)).toBe(false)
    })

    it('rejects SSH URIs', () => {
      expect(isWslPath('ssh://c1/home/user/project')).toBe(false)
    })
  })

  describe('isWslProject', () => {
    it('returns true when project.kind is wsl', () => {
      expect(isWslProject({ kind: 'wsl', path: 'D:/some/path' })).toBe(true)
    })

    it('returns true when project.path is a WSL UNC path', () => {
      expect(
        isWslProject({ kind: 'local', path: String.raw`\\wsl$\Ubuntu\home\code\QingCode` })
      ).toBe(true)
      expect(
        isWslProject({ path: String.raw`\\wsl.localhost\Ubuntu\home\code\QingCode` })
      ).toBe(true)
      expect(isWslProject({ path: 'wsl://Ubuntu/home/code/QingCode' })).toBe(true)
    })

    it('returns false for SSH projects even when the connection is named WSL', () => {
      expect(isWslProject({ kind: 'ssh', path: 'ssh://conn-wsl/home/code' })).toBe(false)
      expect(isWslProject({ kind: 'ssh', path: 'ssh://wsl/home/code' })).toBe(false)
      expect(isWslProject({ path: 'ssh://wsl/home/code' })).toBe(false)
    })

    it('returns false for SSH projects on other hosts', () => {
      expect(isWslProject({ kind: 'ssh', path: 'ssh://c1/root' })).toBe(false)
      expect(isWslProject({ path: 'ssh://c1/root' })).toBe(false)
    })

    it('returns false for regular local projects', () => {
      expect(isWslProject({ kind: 'local', path: 'D:/code/app' })).toBe(false)
      expect(isWslProject({ path: 'D:/code/app' })).toBe(false)
      expect(isWslProject(null)).toBe(false)
      expect(isWslProject(undefined)).toBe(false)
    })
  })

  describe('wslDistroNameFromPath', () => {
    it('extracts distribution name from UNC and URI paths', () => {
      expect(wslDistroNameFromPath(String.raw`\\wsl$\Ubuntu\home\code`)).toBe('Ubuntu')
      expect(wslDistroNameFromPath(String.raw`\\wsl.localhost\Ubuntu-22.04\home`)).toBe('Ubuntu-22.04')
      expect(wslDistroNameFromPath('//wsl$/Debian/etc')).toBe('Debian')
      expect(wslDistroNameFromPath('wsl://Arch/home/user')).toBe('Arch')
    })

    it('returns undefined for non-WSL paths', () => {
      expect(wslDistroNameFromPath('D:/repos/app')).toBeUndefined()
      expect(wslDistroNameFromPath('')).toBeUndefined()
    })
  })

  describe('wslDistroPathFromPath', () => {
    it('extracts posix path inside the distro', () => {
      expect(wslDistroPathFromPath(String.raw`\\wsl$\Ubuntu\home\code\QingCode`)).toBe(
        '/home/code/QingCode'
      )
      expect(wslDistroPathFromPath(String.raw`\\wsl.localhost\Debian\etc\hosts`)).toBe(
        '/etc/hosts'
      )
      expect(wslDistroPathFromPath('//wsl$/Ubuntu/var/log/syslog')).toBe('/var/log/syslog')
      expect(wslDistroPathFromPath('wsl://Ubuntu/home/code')).toBe('/home/code')
    })
  })
})
