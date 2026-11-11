// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest'
import { render, screen } from '@testing-library/react'
import Toaster from './Toaster'
import { useProjectStore } from '../store/projectStore'

afterEach(() => useProjectStore.setState({ toasts: [] }))

describe('Toaster', () => {
  it('renders the {project} placeholder as the project name followed by its source badge', () => {
    useProjectStore.setState({
      toasts: [{ id: 't1', kind: 'success', text: '{project} 已同步 2 个提交', subject: { name: 'django', source: 'WSL' } }],
    })
    render(<Toaster />)
    const message = screen.getByRole('status')
    expect(message).toHaveTextContent('djangoWSL 已同步 2 个提交')
    expect(message).not.toHaveTextContent('{project}')
    const badge = message.querySelector('[data-project-source]')
    expect(badge).toHaveTextContent('WSL')
    expect(badge?.previousElementSibling).toHaveTextContent('django')
  })

  it('keeps plain toasts unchanged', () => {
    useProjectStore.setState({ toasts: [{ id: 't2', kind: 'info', text: '已保存' }] })
    render(<Toaster />)
    expect(screen.getByRole('status')).toHaveTextContent('已保存')
    expect(document.querySelector('[data-project-source]')).toBeNull()
  })
})
