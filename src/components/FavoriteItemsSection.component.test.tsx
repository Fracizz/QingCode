// @vitest-environment jsdom

import { render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Project } from '../types'
import { useFavoriteStore } from '../store/favoriteStore'
import FavoriteItemsSection from './FavoriteItemsSection'

vi.mock('@tauri-apps/plugin-opener', () => ({
  openPath: vi.fn().mockResolvedValue(undefined),
  revealItemInDir: vi.fn().mockResolvedValue(undefined),
}))

const project: Project = {
  id: 'p1',
  name: 'Alpha',
  path: 'D:/alpha',
  created_at: 1,
  last_opened_at: 1,
}

const initialFavoriteState = useFavoriteStore.getState()

describe('FavoriteItemsSection', () => {
  afterEach(() => {
    useFavoriteStore.setState(initialFavoriteState, true)
  })

  it('does not insert a transient section while an empty favorites list loads', async () => {
    const loadProjectFavorites = vi.fn().mockReturnValue(new Promise<void>(() => undefined))
    useFavoriteStore.setState({
      itemsByProject: {},
      loadedProjectIds: [],
      loadingProjectIds: [project.id],
      loadProjectFavorites,
    })

    render(<FavoriteItemsSection project={project} />)

    await waitFor(() => expect(loadProjectFavorites).toHaveBeenCalledWith(project))
    expect(screen.queryByRole('region', { name: '收藏夹' })).not.toBeInTheDocument()
    expect(screen.queryByText('正在加载收藏夹…')).not.toBeInTheDocument()
  })

  it('still renders favorites that are already available', () => {
    useFavoriteStore.setState({
      itemsByProject: {
        [project.id]: [
          {
            projectId: project.id,
            relativePath: 'src/app.tsx',
            kind: 'file',
            sortOrder: 0,
            createdAt: 1,
            available: true,
          },
        ],
      },
      loadedProjectIds: [project.id],
      loadingProjectIds: [],
      loadProjectFavorites: vi.fn().mockResolvedValue(undefined),
    })

    render(<FavoriteItemsSection project={project} />)

    expect(screen.getByRole('region', { name: '收藏夹' })).toBeInTheDocument()
    expect(screen.getByText('src/app.tsx')).toBeInTheDocument()
  })
})
