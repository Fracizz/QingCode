// @vitest-environment jsdom

import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import {
  ProjectKindBadge,
  ProjectKindIcon,
  SshKindBadge,
  WslKindBadge,
} from './ProjectKindMark'

describe('ProjectKindMark', () => {
  describe('ProjectKindIcon', () => {
    it('renders a cloud icon for WSL project', () => {
      const { container } = render(
        <ProjectKindIcon
          project={{ kind: 'wsl', path: 'D:/wsl-project' }}
          className="test-icon"
        />
      )
      const svg = container.querySelector('svg')
      expect(svg).toBeInTheDocument()
      expect(svg).toHaveClass('lucide-cloud')
      expect(svg).toHaveClass('test-icon')
    })

    it('renders a cloud icon for WSL UNC path', () => {
      const { container } = render(
        <ProjectKindIcon
          project={{ path: String.raw`\\wsl$\Ubuntu\home\code\QingCode` }}
        />
      )
      const svg = container.querySelector('svg')
      expect(svg).toHaveClass('lucide-cloud')
    })

    it('renders a cloud icon for SSH project when connection name is WSL', () => {
      const { container } = render(
        <ProjectKindIcon
          project={{ kind: 'ssh', path: 'ssh://c1/home/code/QingCode', connection_id: 'c1' }}
          connections={[{ id: 'c1', name: 'WSL' }]}
        />
      )
      const svg = container.querySelector('svg')
      expect(svg).toHaveClass('lucide-cloud')
    })

    it('renders a cloud icon for SSH projects on POSIX and Windows remotes', () => {
      const { container } = render(
        <ProjectKindIcon
          project={{ kind: 'ssh', path: 'ssh://c1/home/user/project' }}
        />
      )
      expect(container.querySelector('svg')).toHaveClass('lucide-cloud')

      const windowsProject = render(
        <ProjectKindIcon
          project={{
            kind: 'ssh',
            path: 'ssh://c1/D:/code/nem-panel',
            connection_id: 'c1',
          }}
          connections={[{ id: 'c1', name: 'WinDev' }]}
        />
      )
      expect(windowsProject.container.querySelector('svg')).toHaveClass('lucide-cloud')
    })

    it('renders a folder icon for local project', () => {
      const { container } = render(
        <ProjectKindIcon project={{ kind: 'local', path: 'D:/code/local' }} />
      )
      const svg = container.querySelector('svg')
      expect(svg).toHaveClass('lucide-folder')
    })

    it('renders folder-open when open is true for local project', () => {
      const { container } = render(
        <ProjectKindIcon project={{ path: 'D:/code/local' }} open />
      )
      const svg = container.querySelector('svg')
      expect(svg).toHaveClass('lucide-folder-open')
    })
  })

  describe('WslKindBadge', () => {
    it('renders WSL badge text', () => {
      render(<WslKindBadge />)
      expect(screen.getByText('WSL')).toBeInTheDocument()
    })
  })

  describe('SshKindBadge', () => {
    it('renders SSH badge text', () => {
      render(<SshKindBadge />)
      expect(screen.getByText('SSH')).toBeInTheDocument()
    })
  })

  describe('ProjectKindBadge', () => {
    it('renders WslKindBadge for WSL project', () => {
      render(<ProjectKindBadge project={{ kind: 'wsl', path: 'D:/some/path' }} />)
      expect(screen.getByText('WSL')).toBeInTheDocument()
      expect(screen.queryByText('SSH')).not.toBeInTheDocument()
    })

    it('renders WslKindBadge for WSL UNC path', () => {
      render(
        <ProjectKindBadge
          project={{ path: String.raw`\\wsl.localhost\Ubuntu\home\code` }}
        />
      )
      expect(screen.getByText('WSL')).toBeInTheDocument()
    })

    it('renders WslKindBadge for SSH project when connection name is WSL', () => {
      render(
        <ProjectKindBadge
          project={{ kind: 'ssh', path: 'ssh://wsl-conn/home/code', connection_id: 'wsl-conn' }}
          connections={[{ id: 'wsl-conn', name: 'WSL' }]}
        />
      )
      expect(screen.getByText('WSL')).toBeInTheDocument()
      expect(screen.queryByText('SSH')).not.toBeInTheDocument()
    })

    it('renders SshKindBadge for SSH project', () => {
      render(
        <ProjectKindBadge
          project={{ kind: 'ssh', path: 'ssh://dev/home/app' }}
        />
      )
      expect(screen.getByText('SSH')).toBeInTheDocument()
      expect(screen.queryByText('WSL')).not.toBeInTheDocument()
    })

    it('renders nothing for standard local project', () => {
      const { container } = render(
        <ProjectKindBadge project={{ kind: 'local', path: 'C:/repos/app' }} />
      )
      expect(container.firstChild).toBeNull()
    })
  })
})
