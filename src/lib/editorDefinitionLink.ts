import { Prec, StateEffect, StateField, type Extension } from '@codemirror/state'
import { Decoration, EditorView, type DecorationSet } from '@codemirror/view'
import { identifierAt, type IdentifierRange } from './definitionNavigation'

const setDefinitionLink = StateEffect.define<{ from: number; to: number } | null>()
const definitionLinkMark = Decoration.mark({ class: 'cm-definition-link' })

const definitionLinkField = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update(value, transaction) {
    let next = value.map(transaction.changes)
    for (const effect of transaction.effects) {
      if (!effect.is(setDefinitionLink)) continue
      next = effect.value
        ? Decoration.set([definitionLinkMark.range(effect.value.from, effect.value.to)])
        : Decoration.none
    }
    return next
  },
  provide: field => EditorView.decorations.from(field),
})

function modified(event: MouseEvent | KeyboardEvent): boolean {
  return (event.ctrlKey || event.metaKey) && !event.altKey
}

interface DefinitionLinkActions {
  navigate: (view: EditorView, identifier: IdentifierRange) => void | Promise<void>
  linkEnabled?: () => boolean
}

/**
 * IDEA/VS-style definition link. Ctrl/Meta only marks the identifier as clickable;
 * project lookup and navigation start on Ctrl/Meta + left click.
 */
export function editorDefinitionLink(actions: DefinitionLinkActions): Extension {
  let lastPoint: { x: number; y: number } | null = null
  let lastRange = ''
  let lastNavigation:
    | { x: number; y: number; at: number }
    | null = null

  const updateLink = (
    view: EditorView,
    point: { x: number; y: number } | null
  ): IdentifierRange | null => {
    const position = point ? view.posAtCoords(point) : null
    const identifier =
      position === null || actions.linkEnabled?.() === false
        ? null
        : identifierAt(view.state, position)
    const key = identifier ? `${identifier.from}:${identifier.to}` : ''
    if (key === lastRange) return identifier
    lastRange = key
    view.dispatch({
      effects: setDefinitionLink.of(
        identifier ? { from: identifier.from, to: identifier.to } : null
      ),
    })
    return identifier
  }

  const navigateFromMouse = (event: MouseEvent, view: EditorView): boolean => {
    if (event.button !== 0 || !modified(event)) return false
    const position = view.posAtCoords({ x: event.clientX, y: event.clientY })
    if (position === null) return false
    const identifier = identifierAt(view.state, position)
    if (!identifier) return false
    event.preventDefault()
    event.stopPropagation()
    updateLink(view, null)
    lastNavigation = {
      x: event.clientX,
      y: event.clientY,
      at: Date.now(),
    }
    void actions.navigate(view, identifier)
    return true
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
      return navigateFromMouse(event, view)
    },
    click(event, view) {
      const duplicate =
        lastNavigation &&
        Date.now() - lastNavigation.at < 800 &&
        Math.abs(lastNavigation.x - event.clientX) <= 2 &&
        Math.abs(lastNavigation.y - event.clientY) <= 2
      if (duplicate) {
        event.preventDefault()
        event.stopPropagation()
        lastNavigation = null
        return true
      }
      return navigateFromMouse(event, view)
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
