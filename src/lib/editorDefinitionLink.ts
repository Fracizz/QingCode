import { Prec, StateEffect, StateField, type Extension } from '@codemirror/state'
import { Decoration, EditorView, type DecorationSet } from '@codemirror/view'
import {
  identifierAt,
  type IdentifierRange,
} from './definitionNavigation'

const setDefinitionLink = StateEffect.define<{ from: number; to: number } | null>()
const definitionLinkMark = Decoration.mark({ class: 'cm-definition-link' })

const definitionLinkField = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update(value, transaction) {
    let next = value.map(transaction.changes)
    for (const effect of transaction.effects) {
      if (!effect.is(setDefinitionLink)) continue
      next = effect.value
        ? Decoration.set([
            definitionLinkMark.range(effect.value.from, effect.value.to),
          ])
        : Decoration.none
    }
    return next
  },
  provide: field => EditorView.decorations.from(field),
})

function modified(event: MouseEvent | KeyboardEvent): boolean {
  return (event.ctrlKey || event.metaKey) && !event.altKey
}

/**
 * IDEA/VS-style definition link. Hover remains frontend-only and synchronous;
 * the potentially expensive project lookup starts only after Ctrl+click.
 */
export function editorDefinitionLink(
  navigate: (view: EditorView, identifier: IdentifierRange) => void | Promise<void>
): Extension {
  let lastPoint: { x: number; y: number } | null = null
  let lastRange = ''

  const updateLink = (view: EditorView, point: { x: number; y: number } | null) => {
    const position = point ? view.posAtCoords(point) : null
    const identifier = position === null ? null : identifierAt(view.state, position)
    const key = identifier ? `${identifier.from}:${identifier.to}` : ''
    if (key === lastRange) return
    lastRange = key
    view.dispatch({
      effects: setDefinitionLink.of(
        identifier ? { from: identifier.from, to: identifier.to } : null
      ),
    })
  }

  const handlers = EditorView.domEventHandlers({
    mousemove(event, view) {
      lastPoint = { x: event.clientX, y: event.clientY }
      updateLink(view, modified(event) ? lastPoint : null)
      return false
    },
    mouseleave(_event, view) {
      lastPoint = null
      updateLink(view, null)
      return false
    },
    keydown(event, view) {
      if ((event.key === 'Control' || event.key === 'Meta') && lastPoint) {
        updateLink(view, lastPoint)
      }
      return false
    },
    keyup(event, view) {
      if (event.key === 'Control' || event.key === 'Meta') updateLink(view, null)
      return false
    },
    blur(_event, view) {
      updateLink(view, null)
      return false
    },
    mousedown(event, view) {
      if (event.button !== 0 || !modified(event)) return false
      const position = view.posAtCoords({ x: event.clientX, y: event.clientY })
      if (position === null) return false
      const identifier = identifierAt(view.state, position)
      if (!identifier) return false
      event.preventDefault()
      event.stopPropagation()
      updateLink(view, null)
      void navigate(view, identifier)
      return true
    },
  })

  return [
    definitionLinkField,
    Prec.highest(handlers),
    EditorView.theme({
      '.cm-definition-link': {
        color: 'var(--color-accent)',
        cursor: 'pointer',
        textDecoration: 'underline',
        textUnderlineOffset: '2px',
      },
    }),
  ]
}
