import {
  Decoration,
  EditorView,
  ViewPlugin,
  type ViewUpdate,
  type PluginValue,
} from '@codemirror/view'
import { StateEffect, StateField, type Extension } from '@codemirror/state'
import { identifierAt } from './tokenAt'
import { runGoToDefinitionAt } from './runGoToDefinition'

const setHoverToken = StateEffect.define<{ from: number; to: number } | null>()

const hoverMark = Decoration.mark({ class: 'cm-gotoDefinition-hover' })

const hoverTokenField = StateField.define<{ from: number; to: number } | null>({
  create: () => null,
  update(value, tr) {
    for (const effect of tr.effects) {
      if (effect.is(setHoverToken)) return effect.value
    }
    if (tr.docChanged) return null
    return value
  },
  provide: field =>
    EditorView.decorations.from(field, range => {
      if (!range) return Decoration.none
      return Decoration.set([hoverMark.range(range.from, range.to)])
    }),
})

function isModEvent(event: MouseEvent | KeyboardEvent): boolean {
  return event.ctrlKey || event.metaKey
}

class GotoDefinitionPlugin implements PluginValue {
  constructor(private readonly view: EditorView) {
    this.onKeyUp = this.onKeyUp.bind(this)
    this.onBlur = this.onBlur.bind(this)
    this.onMouseMove = this.onMouseMove.bind(this)
    this.onMouseDown = this.onMouseDown.bind(this)
    window.addEventListener('keyup', this.onKeyUp, true)
    window.addEventListener('blur', this.onBlur)
    view.dom.addEventListener('mousemove', this.onMouseMove)
    view.dom.addEventListener('mousedown', this.onMouseDown, true)
  }

  update(_update: ViewUpdate) {}

  destroy() {
    window.removeEventListener('keyup', this.onKeyUp, true)
    window.removeEventListener('blur', this.onBlur)
    this.view.dom.removeEventListener('mousemove', this.onMouseMove)
    this.view.dom.removeEventListener('mousedown', this.onMouseDown, true)
  }

  private onKeyUp(event: KeyboardEvent) {
    if (event.key === 'Control' || event.key === 'Meta' || (!event.ctrlKey && !event.metaKey)) {
      this.clearHover()
    }
  }

  private onBlur() {
    this.clearHover()
  }

  private clearHover() {
    if (this.view.state.field(hoverTokenField)) {
      this.view.dispatch({ effects: setHoverToken.of(null) })
    }
  }

  private onMouseMove(event: MouseEvent) {
    if (!isModEvent(event)) {
      if (this.view.state.field(hoverTokenField)) this.clearHover()
      return
    }
    const pos = this.view.posAtCoords({ x: event.clientX, y: event.clientY })
    if (pos == null) {
      this.clearHover()
      return
    }
    const token = identifierAt(this.view.state, pos)
    const current = this.view.state.field(hoverTokenField)
    if (!token) {
      if (current) this.clearHover()
      return
    }
    if (current && current.from === token.from && current.to === token.to) return
    this.view.dispatch({ effects: setHoverToken.of({ from: token.from, to: token.to }) })
  }

  private onMouseDown(event: MouseEvent) {
    if (!isModEvent(event) || event.button !== 0) return
    const pos = this.view.posAtCoords({ x: event.clientX, y: event.clientY })
    if (pos == null) return
    const token = identifierAt(this.view.state, pos)
    if (!token) return
    event.preventDefault()
    event.stopPropagation()
    void runGoToDefinitionAt(token.from)
  }
}

const gotoDefinitionTheme = EditorView.theme({
  '.cm-gotoDefinition-hover': {
    textDecoration: 'underline',
    cursor: 'pointer',
  },
})

/** Lightweight Ctrl/Cmd+hover underline and Ctrl/Cmd+click jump. */
export function gotoDefinitionExtension(): Extension {
  return [hoverTokenField, ViewPlugin.fromClass(GotoDefinitionPlugin), gotoDefinitionTheme]
}
