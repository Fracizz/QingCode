// @vitest-environment jsdom

import { describe, expect, it } from 'vitest'
import { mergeDiffSignGutter } from './mergeDiffSignGutter'
import { MergeView } from '@codemirror/merge'

describe('mergeDiffSignGutter', () => {
  it('renders minus and plus markers on changed lines', () => {
    const parent = document.createElement('div')
    document.body.appendChild(parent)
    const merge = new MergeView({
      parent,
      gutter: false,
      a: {
        doc: 'alpha\nbeta\n',
        extensions: [mergeDiffSignGutter('a')],
      },
      b: {
        doc: 'alpha\ngamma\n',
        extensions: [mergeDiffSignGutter('b')],
      },
    })

    const minus = parent.querySelector('.qc-diff-sign-minus')
    const plus = parent.querySelector('.qc-diff-sign-plus')
    expect(minus?.textContent).toBe('−')
    expect(plus?.textContent).toBe('+')

    merge.destroy()
    parent.remove()
  })
})
