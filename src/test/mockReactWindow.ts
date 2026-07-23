import { createElement, type ReactElement } from 'react'

/**
 * Stub for `react-window`'s `List` + `useListRef` used by component tests.
 *
 * The real `List` virtualizes rows; this stub renders every row synchronously so
 * Testing Library queries can find them. Mirrors the inline stub already used by
 * `SourceControlPanel.component.test.tsx`, exposed here for reuse.
 *
 * Apply at the top of a test file (the factory is self-contained — no external
 * bindings — so it is safe to reference from a hoisted `vi.mock` factory):
 *
 * ```ts
 * vi.mock('react-window', () => reactWindowMockFactory())
 * ```
 *
 * If vitest still complains about referencing the imported factory from the
 * hoisted factory, inline the factory instead and treat this stub as the source
 * of truth to copy.
 */
export function reactWindowMockFactory(): {
  List: (props: Record<string, unknown>) => ReactElement
  useListRef: () => { current: unknown }
} {
  const List = (props: Record<string, unknown>): ReactElement => {
    const rowCount = props.rowCount as number
    const Row = props.rowComponent as (p: Record<string, unknown>) => ReactElement | null
    const rowProps = (props.rowProps ?? {}) as Record<string, unknown>
    return createElement(
      'div',
      null,
      Array.from({ length: rowCount }, (_, index) =>
        createElement(Row, {
          key: index,
          index,
          style: {},
          ariaAttributes: {
            'aria-posinset': index + 1,
            'aria-setsize': rowCount,
            role: 'listitem',
          },
          ...rowProps,
        }),
      ),
    )
  }
  const useListRef = () => ({ current: null })
  return { List, useListRef }
}
