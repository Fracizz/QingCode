// @vitest-environment jsdom

import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import MarkdownRichText from './MarkdownRichText'

describe('MarkdownRichText', () => {
  it('hides empty HTML anchors from release notes without enabling raw HTML', () => {
    const { container } = render(
      <MarkdownRichText
        content={'[English](#english)\n\n<a id="english"></a>\n\n### English\n\n<b>Important</b>'}
      />,
    )

    expect(screen.queryByText('<a id="english"></a>')).not.toBeInTheDocument()
    expect(screen.getByRole('heading', { name: 'English' })).toHaveAttribute('id', 'english')
    expect(container).toHaveTextContent('<b>Important</b>')
  })

  it('maps internal release-note links to rendered headings', () => {
    render(<MarkdownRichText content={'[中文](#中文)\n\n### 中文'} />)

    expect(screen.getByRole('heading', { name: '中文' })).toHaveAttribute('id', '中文')
    expect(fireEvent.click(screen.getByRole('link', { name: '中文' }))).toBe(false)
  })
})
