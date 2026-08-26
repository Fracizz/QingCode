import { Prec, StateEffect, StateField, type Extension } from '@codemirror/state'
import { Decoration, EditorView, ViewPlugin, type DecorationSet } from '@codemirror/view'
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

function eventHasPrimaryModifier(event: MouseEvent | KeyboardEvent): boolean {
  if ((event.ctrlKey || event.metaKey) && !event.altKey) return true
  // Packaged WebView2 sometimes clears ctrlKey/metaKey on mouse events while still
  // reporting the pressed modifier via getModifierState.
  if ('getModifierState' in event && typeof event.getModifierState === 'function') {
    try {
      if ((event.getModifierState('Control') || event.getModifierState('Meta')) && !event.altKey) {
        return true
      }
    } catch {
      // Older / incomplete MouseEvent mocks may throw; ignore.
    }
  }
  return false
}

interface DefinitionLinkActions {
  navigate: (view: EditorView, identifier: IdentifierRange) => void | Promise<void>
  linkEnabled?: () => boolean
  nativeModifierPressed?: () => Promise<boolean>
}

/**
 * IDEA/VS-style definition link. Ctrl/Meta only marks the identifier as clickable;
 * project lookup and navigation start on Ctrl/Meta + left click.
 *
 * Packaged WebView2 often drops ctrlKey from mousedown and may deliver Control
 * keydown outside the editor contentDOM. Track modifiers on window + mouse move.
 */
export function editorDefinitionLink(actions: DefinitionLinkActions): Extension {
  let lastPoint: { x: number; y: number } | null = null
  let lastRange = ''
  let modifierHeld = false
  let lastNavigation: { x: number; y: number; at: number } | null = null
  let lastNativeProbe: { x: number; y: number; at: number } | null = null
  let nativeProbePending = false
  let activeView: EditorView | null = null

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

  const setModifierHeld = (held: boolean) => {
    if (modifierHeld === held) return
    modifierHeld = held
    if (!activeView) return
    if (held && lastPoint) updateLink(activeView, lastPoint)
    else if (!held) updateLink(activeView, null)
  }

  const navigateToIdentifier = (
    view: EditorView,
    identifier: IdentifierRange,
    point: { x: number; y: number }
  ) => {
    updateLink(view, null)
    lastNavigation = { ...point, at: Date.now() }
    void actions.navigate(view, identifier)
  }

  const navigateFromMouse = (event: MouseEvent, view: EditorView): boolean => {
    if (actions.linkEnabled?.() === false) {
      if (!eventHasPrimaryModifier(event)) return false
      event.preventDefault()
      event.stopPropagation()
      return true
    }
    if (event.button !== 0) return false
    const position = view.posAtCoords({ x: event.clientX, y: event.clientY })
    if (position === null) return false
    const identifier = identifierAt(view.state, position)
    if (!identifier) return false

    const point = { x: event.clientX, y: event.clientY }
    if (eventHasPrimaryModifier(event) || modifierHeld) {
      event.preventDefault()
      event.stopPropagation()
      navigateToIdentifier(view, identifier, point)
      return true
    }

    if (!actions.nativeModifierPressed || nativeProbePending) return false
    const duplicateProbe =
      lastNativeProbe &&
      Date.now() - lastNativeProbe.at < 500 &&
      Math.abs(lastNativeProbe.x - point.x) <= 2 &&
      Math.abs(lastNativeProbe.y - point.y) <= 2
    if (duplicateProbe) return false

    // This runs for otherwise-plain clicks in packaged builds. The native
    // GetAsyncKeyState result is authoritative when WebView2 drops ctrlKey.
    lastNativeProbe = { ...point, at: Date.now() }
    nativeProbePending = true
    void actions
      .nativeModifierPressed()
      .then(pressed => {
        if (!pressed || !view.dom.isConnected) return
        navigateToIdentifier(view, identifier, point)
      })
      .finally(() => {
        nativeProbePending = false
      })
    return false
  }

  const onWindowKeyDown = (event: KeyboardEvent) => {
    if (event.key === 'Control' || event.key === 'Meta' || eventHasPrimaryModifier(event)) {
      setModifierHeld(true)
    }
  }
  const onWindowKeyUp = (event: KeyboardEvent) => {
    if (event.key === 'Control' || event.key === 'Meta') {
      setModifierHeld(false)
      return
    }
    // Another key may report the current modifier state after Control was released.
    if (!eventHasPrimaryModifier(event)) setModifierHeld(false)
  }
  const onWindowBlur = () => setModifierHeld(false)

  const modifierPlugin = ViewPlugin.fromClass(
    class {
      constructor(view: EditorView) {
        activeView = view
        window.addEventListener('keydown', onWindowKeyDown, true)
        window.addEventListener('keyup', onWindowKeyUp, true)
        window.addEventListener('blur', onWindowBlur)
      }
      destroy() {
        window.removeEventListener('keydown', onWindowKeyDown, true)
        window.removeEventListener('keyup', onWindowKeyUp, true)
        window.removeEventListener('blur', onWindowBlur)
        if (activeView) {
          // Only clear when this plugin instance owned the view.
          activeView = null
        }
        modifierHeld = false
        lastPoint = null
        lastRange = ''
      }
    }
  )

  const handlers = EditorView.domEventHandlers({
    mousemove(event, view) {
      lastPoint = { x: event.clientX, y: event.clientY }
      // Mouse move carries reliable modifier flags even when keydown missed the editor.
      if (eventHasPrimaryModifier(event)) modifierHeld = true
      else if (!modifierHeld) {
        // Leave window-tracked Control alone when the mouse event simply omits flags.
      }
      updateLink(view, modifierHeld || eventHasPrimaryModifier(event) ? lastPoint : null)
      return false
    },
    mouseleave(_event, view) {
      lastPoint = null
      updateLink(view, null)
      return false
    },
    keydown(event, view) {
      if (event.key === 'Control' || event.key === 'Meta' || eventHasPrimaryModifier(event)) {
        modifierHeld = true
        if (lastPoint) updateLink(view, lastPoint)
      }
      return false
    },
    keyup(event, view) {
      if (event.key === 'Control' || event.key === 'Meta') {
        modifierHeld = false
        updateLink(view, null)
      }
      return false
    },
    blur(_event, view) {
      // Keep window-level modifierHeld; editor blur alone is common during navigation.
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
    modifierPlugin,
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
