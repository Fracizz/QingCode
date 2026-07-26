import { Prec, StateEffect, StateField, type Extension } from '@codemirror/state'
import { Decoration, EditorView, type DecorationSet } from '@codemirror/view'
import { identifierAt, type DefinitionAnchor, type IdentifierRange } from './definitionNavigation'

const setDefinitionLink = StateEffect.define<{ from: number; to: number } | null>()
const definitionLinkMark = Decoration.mark({ class: 'cm-definition-link' })
let nextDefinitionPreviewRequest = 0

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
  preview?: (
    view: EditorView,
    identifier: IdentifierRange,
    anchor: DefinitionAnchor,
    requestId: number,
    isCurrent: () => boolean
  ) => void | Promise<void>
  dismissPreview?: (modifierHeld: boolean, force?: boolean) => void
  setModifierHeld?: (held: boolean) => void
}

/**
 * IDEA/VS-style definition link with a delayed semantic preview.
 */
export function editorDefinitionLink(actions: DefinitionLinkActions): Extension {
  let lastPoint: { x: number; y: number } | null = null
  let lastRange = ''
  let previewTimer: number | null = null
  let previewRequest = 0

  const cancelPreview = (modifierHeld: boolean, force = false) => {
    if (previewTimer !== null) {
      window.clearTimeout(previewTimer)
      previewTimer = null
    }
    previewRequest += 1
    actions.dismissPreview?.(modifierHeld, force)
  }

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
    cancelPreview(Boolean(point))
    lastRange = key
    view.dispatch({
      effects: setDefinitionLink.of(
        identifier ? { from: identifier.from, to: identifier.to } : null
      ),
    })
    if (identifier && point && actions.preview) {
      const generation = ++previewRequest
      const requestId = ++nextDefinitionPreviewRequest
      previewTimer = window.setTimeout(() => {
        previewTimer = null
        const coords = view.coordsAtPos(identifier.from)
        const anchor = coords
          ? {
              left: coords.left,
              top: coords.top,
              right: coords.right,
              bottom: coords.bottom,
            }
          : {
              left: point.x,
              top: point.y,
              right: point.x,
              bottom: point.y + 18,
            }
        void actions.preview?.(
          view,
          identifier,
          anchor,
          requestId,
          () => generation === previewRequest && lastRange === key
        )
      }, 300)
    }
    return identifier
  }

  const handlers = EditorView.domEventHandlers({
    mousemove(event, view) {
      lastPoint = { x: event.clientX, y: event.clientY }
      actions.setModifierHeld?.(modified(event))
      updateLink(view, modified(event) ? lastPoint : null)
      return false
    },
    mouseleave(_event, view) {
      lastPoint = null
      actions.setModifierHeld?.(false)
      updateLink(view, null)
      return false
    },
    keydown(event, view) {
      if ((event.key === 'Control' || event.key === 'Meta') && lastPoint) {
        actions.setModifierHeld?.(true)
        updateLink(view, lastPoint)
      }
      return false
    },
    keyup(event, view) {
      if (event.key === 'Control' || event.key === 'Meta') {
        actions.setModifierHeld?.(false)
        updateLink(view, null)
        actions.dismissPreview?.(false)
      }
      return false
    },
    blur(_event, view) {
      actions.setModifierHeld?.(false)
      updateLink(view, null)
      cancelPreview(false, true)
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
      cancelPreview(false, true)
      void actions.navigate(view, identifier)
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
