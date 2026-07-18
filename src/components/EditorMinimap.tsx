import { useCallback, useEffect, useRef, useState } from 'react'
import { EditorView } from '@codemirror/view'
import { getResolvedTheme } from '../lib/themeSettings'
import type { EditorTab } from '../types'

// ─── Constants ───────────────────────────────────────────────────────────────

/** Minimap 默认宽度 */
export const MINIMAP_DEFAULT_WIDTH = 120
/** Minimap 最小宽度 */
export const MINIMAP_MIN_WIDTH = 60
/** Minimap 最大宽度 */
export const MINIMAP_MAX_WIDTH = 200
/** 编辑器最小安全宽度（px）—— 拖动时保证编辑器不会太小 */
export const EDITOR_MIN_WIDTH = 400
/** 文件大小限制：超过此值的文件不显示 minimap（5MB） */
export const MINIMAP_MAX_FILE_SIZE = 5 * 1024 * 1024
/** 文件大小软限制：超过此值显示简化 minimap（1MB） */
export const MINIMAP_SOFT_MAX_FILE_SIZE = 1 * 1024 * 1024

// ─── Theme Colors for Canvas ─────────────────────────────────────────────────

function getThemeColors() {
  const resolved = getResolvedTheme()

  if (resolved === 'forest') {
    return {
      bg: '#1e2b24',
      fg: '#a9b7c6',
      keyword: '#cc7832',
      string: '#6a8759',
      number: '#6897bb',
      comment: '#808080',
      function: '#ffc66d',
      type: '#bbb529',
      operator: '#a9b7c6',
      property: '#9876aa',
      tag: '#e8bf6a',
      variable: '#a9b7c6',
      accent: '#4ECDB5',
      selection: 'rgba(78, 205, 181, 0.25)',
    }
  }

  if (resolved === 'light') {
    return {
      bg: '#f0f0f0',
      fg: '#1f1f1f',
      keyword: '#0000ff',
      string: '#a31515',
      number: '#098658',
      comment: '#008000',
      function: '#795e26',
      type: '#267f99',
      operator: '#1f1f1f',
      property: '#001080',
      tag: '#800000',
      variable: '#001080',
      accent: '#007acc',
      selection: 'rgba(0, 122, 204, 0.25)',
    }
  }

  // dark (default)
  return {
    bg: '#1e1e1e',
    fg: '#d4d4d4',
    keyword: '#569cd6',
    string: '#ce9178',
    number: '#b5cea8',
    comment: '#6a9955',
    function: '#dcdcaa',
    type: '#4ec9b0',
    operator: '#d4d4d4',
    property: '#9cdcfe',
    tag: '#569cd6',
    variable: '#9cdcfe',
    accent: '#4d9eff',
    selection: 'rgba(77, 158, 255, 0.25)',
  }
}

// ─── Simple Tokenizer for Canvas ─────────────────────────────────────────────

interface Token {
  text: string
  type: 'keyword' | 'string' | 'number' | 'comment' | 'function' | 'type' | 'operator' | 'property' | 'tag' | 'variable' | 'default'
}

const KEYWORDS = new Set([
  'import', 'export', 'from', 'const', 'let', 'var', 'function', 'class', 'interface',
  'type', 'enum', 'return', 'if', 'else', 'for', 'while', 'do', 'switch', 'case',
  'break', 'continue', 'try', 'catch', 'finally', 'throw', 'new', 'this', 'super',
  'extends', 'implements', 'async', 'await', 'yield', 'typeof', 'instanceof',
  'void', 'null', 'undefined', 'true', 'false', 'public', 'private', 'protected',
  'static', 'readonly', 'abstract', 'namespace', 'module', 'declare', 'def',
  'in', 'of', 'as', 'is', 'with', 'assert', 'raise', 'except', 'pass', 'lambda',
  'global', 'nonlocal', 'del',
])

function tokenizeLine(line: string): Token[] {
  const tokens: Token[] = []
  let i = 0

  while (i < line.length) {
    // Skip whitespace
    if (/\s/.test(line[i])) {
      let j = i
      while (j < line.length && /\s/.test(line[j])) j++
      tokens.push({ text: line.slice(i, j), type: 'default' })
      i = j
      continue
    }

    // String literals
    if (line[i] === '"' || line[i] === "'" || line[i] === '`') {
      const quote = line[i]
      let j = i + 1
      while (j < line.length && line[j] !== quote) {
        if (line[j] === '\\') j++
        j++
      }
      tokens.push({ text: line.slice(i, j + 1), type: 'string' })
      i = j + 1
      continue
    }

    // Comments
    if (line[i] === '/' && line[i + 1] === '/') {
      tokens.push({ text: line.slice(i), type: 'comment' })
      break
    }
    if (line[i] === '#') {
      tokens.push({ text: line.slice(i), type: 'comment' })
      break
    }

    // Numbers
    if (/\d/.test(line[i]) || (line[i] === '.' && /\d/.test(line[i + 1] || ''))) {
      let j = i
      while (j < line.length && (/\d/.test(line[j]) || line[j] === '.' || line[j] === 'e' || line[j] === 'E' || line[j] === '+' || line[j] === '-')) j++
      tokens.push({ text: line.slice(i, j), type: 'number' })
      i = j
      continue
    }

    // Identifiers and keywords
    if (/[a-zA-Z_$]/.test(line[i])) {
      let j = i
      while (j < line.length && /[a-zA-Z0-9_$]/.test(line[j])) j++
      const word = line.slice(i, j)
      if (KEYWORDS.has(word)) {
        tokens.push({ text: word, type: 'keyword' })
      } else if (line[j] === '(') {
        tokens.push({ text: word, type: 'function' })
      } else if (/^[A-Z]/.test(word)) {
        tokens.push({ text: word, type: 'type' })
      } else {
        tokens.push({ text: word, type: 'variable' })
      }
      i = j
      continue
    }

    // Operators and other characters
    tokens.push({ text: line[i], type: 'operator' })
    i++
  }

  return tokens
}

// ─── Canvas Renderer ─────────────────────────────────────────────────────────

interface MinimapRenderOptions {
  content: string
  width: number
  simplified: boolean // true for files > 1MB
}

function renderMinimap(canvas: HTMLCanvasElement, options: MinimapRenderOptions) {
  const { content, width, simplified } = options
  const ctx = canvas.getContext('2d')!
  const colors = getThemeColors()
  const lines = content.split('\n')

  // Calculate dimensions
  const lineHeight = simplified ? 1.5 : 2.5
  const totalHeight = lines.length * lineHeight

  // Set canvas size
  const dpr = window.devicePixelRatio || 1
  canvas.width = width * dpr
  canvas.height = Math.max(totalHeight, 100) * dpr
  ctx.scale(dpr, dpr)

  // Background
  ctx.fillStyle = colors.bg
  ctx.fillRect(0, 0, width, canvas.height / dpr)

  if (simplified) {
    // Simplified mode: just draw line bars with varying brightness
    lines.forEach((line, i) => {
      const y = i * lineHeight
      const brightness = Math.min(1, line.length / 80)
      const alpha = 0.3 + brightness * 0.5
      ctx.fillStyle = `rgba(150, 150, 150, ${alpha})`
      const barWidth = Math.min(width - 4, (line.length / 80) * width)
      ctx.fillRect(2, y, barWidth, lineHeight - 0.5)
    })
  } else {
    // Full mode: token-based coloring
    ctx.font = `${lineHeight * 1.2}px monospace`
    ctx.textBaseline = 'top'

    lines.forEach((line, lineIndex) => {
      const y = lineIndex * lineHeight
      const tokens = tokenizeLine(line)
      let x = 2

      for (const token of tokens) {
        if (x >= width - 2) break

        switch (token.type) {
          case 'keyword':
            ctx.fillStyle = colors.keyword
            break
          case 'string':
            ctx.fillStyle = colors.string
            break
          case 'number':
            ctx.fillStyle = colors.number
            break
          case 'comment':
            ctx.fillStyle = colors.comment
            break
          case 'function':
            ctx.fillStyle = colors.function
            break
          case 'type':
            ctx.fillStyle = colors.type
            break
          default:
            ctx.fillStyle = colors.fg
        }

        ctx.fillText(token.text, x, y)
        x += ctx.measureText(token.text).width
      }
    })
  }
}

// ─── Component ───────────────────────────────────────────────────────────────

interface EditorMinimapProps {
  /** The main CodeMirror EditorView to sync with */
  mainView: EditorView | null
  /** Current active tab */
  activeTab: EditorTab | undefined
  /** Whether minimap is enabled */
  enabled: boolean
  /** Current width */
  width: number
  /** Called when width changes via drag */
  onWidthChange: (width: number) => void
}

export default function EditorMinimap({
  mainView,
  activeTab,
  enabled,
  width,
  onWidthChange,
}: EditorMinimapProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const containerRef = useRef<HTMLDivElement>(null)
  const [isDragging, setIsDragging] = useState(false)
  const dragStartX = useRef(0)
  const dragStartWidth = useRef(0)
  const [viewportTop, setViewportTop] = useState(0)
  const [viewportHeight, setViewportHeight] = useState(0)

  // Check if file is too large for minimap
  const fileSize = activeTab?.fileSize ?? activeTab?.content?.length ?? 0
  const isSimplified = fileSize > MINIMAP_SOFT_MAX_FILE_SIZE
  const isDisabled = fileSize > MINIMAP_MAX_FILE_SIZE

  // ─── Render minimap content ──────────────────────────────────────────────
  useEffect(() => {
    if (!enabled || !activeTab || !activeTab.content || isDisabled) return

    const canvas = canvasRef.current
    if (!canvas) return

    const content = activeTab.content
    renderMinimap(canvas, {
      content,
      width,
      simplified: isSimplified,
    })
  }, [enabled, activeTab, width, isSimplified, isDisabled])

  // ─── Scroll sync: main editor → minimap viewport indicator ────────────────
  useEffect(() => {
    if (!enabled || !mainView || isDisabled) return

    const updateViewport = () => {
      const scroller = mainView.scrollDOM
      const scrollTop = scroller.scrollTop
      const scrollHeight = scroller.scrollHeight - scroller.clientHeight
      const clientHeight = scroller.clientHeight

      if (scrollHeight <= 0) {
        setViewportTop(0)
        setViewportHeight(100)
        return
      }

      const topPercent = (scrollTop / scrollHeight) * 100
      const heightPercent = (clientHeight / scroller.scrollHeight) * 100

      setViewportTop(topPercent)
      setViewportHeight(Math.max(heightPercent, 3)) // minimum 3% height
    }

    const scroller = mainView.scrollDOM
    scroller.addEventListener('scroll', updateViewport, { passive: true })
    updateViewport()

    return () => {
      scroller.removeEventListener('scroll', updateViewport)
    }
  }, [enabled, mainView, isDisabled])

  // ─── Click/drag on minimap → scroll main editor ───────────────────────────
  const handleMinimapClick = useCallback((e: React.MouseEvent<HTMLDivElement>) => {
    if (!mainView) return

    const rect = containerRef.current?.getBoundingClientRect()
    if (!rect) return

    const clickY = e.clientY - rect.top
    const containerHeight = rect.height
    const scrollRatio = clickY / containerHeight

    const scroller = mainView.scrollDOM
    const maxScroll = scroller.scrollHeight - scroller.clientHeight
    const targetScroll = scrollRatio * maxScroll

    scroller.scrollTop = Math.max(0, Math.min(targetScroll, maxScroll))
  }, [mainView])

  // ─── Drag resizer ─────────────────────────────────────────────────────────
  const handleResizerMouseDown = useCallback((e: React.MouseEvent) => {
    e.preventDefault()
    e.stopPropagation()
    setIsDragging(true)
    dragStartX.current = e.clientX
    dragStartWidth.current = width

    const handleMouseMove = (ev: MouseEvent) => {
      const delta = dragStartX.current - ev.clientX // dragging left = wider
      const newWidth = Math.max(MINIMAP_MIN_WIDTH, Math.min(MINIMAP_MAX_WIDTH, dragStartWidth.current + delta))
      onWidthChange(newWidth)
    }

    const handleMouseUp = () => {
      setIsDragging(false)
      window.removeEventListener('mousemove', handleMouseMove)
      window.removeEventListener('mouseup', handleMouseUp)
    }

    window.addEventListener('mousemove', handleMouseMove)
    window.addEventListener('mouseup', handleMouseUp)
  }, [width, onWidthChange])

  // ─── Render ───────────────────────────────────────────────────────────────
  if (!enabled || !activeTab || isDisabled) {
    return null
  }

  return (
    <div className="flex h-full flex-shrink-0 overflow-hidden" style={{ width }}>
      {/* Drag resizer (left edge of minimap) */}
      <div
        className="flex-shrink-0 w-1 cursor-col-resize hover:bg-accent/30 active:bg-accent/60 transition-colors"
        onMouseDown={handleResizerMouseDown}
        style={{ cursor: isDragging ? 'col-resize' : undefined }}
      />

      {/* Minimap content */}
      <div
        ref={containerRef}
        className="flex-1 relative overflow-hidden cursor-pointer select-none"
        onClick={handleMinimapClick}
      >
        <canvas
          ref={canvasRef}
          className="block w-full"
          style={{ imageRendering: 'pixelated' }}
        />

        {/* Viewport indicator */}
        <div
          className="absolute left-0 right-0 border-y border-accent/40 bg-accent/10 pointer-events-none"
          style={{
            top: `${viewportTop}%`,
            height: `${viewportHeight}%`,
          }}
        />

        {/* Current line indicator */}
        <div
          className="absolute left-0 right-0 h-px bg-accent/60 pointer-events-none"
          style={{
            top: `${viewportTop + viewportHeight / 2}%`,
          }}
        />
      </div>
    </div>
  )
}
