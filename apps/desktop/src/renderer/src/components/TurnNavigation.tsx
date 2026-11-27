import { useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent, type RefObject } from 'react'
import { t } from '@qn/codex-client'
import { splitUserText } from '../lib/attachments'
import { isAtBottom } from '../lib/diff'
import type { TurnEntry } from '../lib/turnGroups'
import { Tip } from './primitives'

type TurnLink = { id: string; index: number; prompt: string; reply?: string }

const excerpt = (text: string, limit: number) => {
  const compact = text.trim().replace(/\s+/g, ' ')
  return compact.length > limit ? compact.slice(0, limit) + '…' : compact
}

function turnLinks(flow: TurnEntry[]): TurnLink[] {
  const links: TurnLink[] = []
  flow.forEach((entry, index) => {
    if (entry.kind !== 'item') return
    const { item } = entry
    if (item.kind === 'user') {
      const { text, files, skills } = splitUserText(item.text)
      const prompt = excerpt(text, 180) || [
        item.images?.length ? t('图片') : '',
        item.files?.length || files.length ? t('附件') : '',
        ...(item.skills?.length ? item.skills : skills).map((name) => '/' + name),
      ].filter(Boolean).join(' · ') || t('用户消息')
      links.push({ id: entry.key, index, prompt })
    } else if (item.kind === 'agent') {
      const link = links.at(-1)
      const reply = excerpt(item.text, 320)
      if (link && reply) link.reply = reply
    }
  })
  return links
}

export function TurnNavigation({
  flow, firstVisible, scrollRef, contentRef, onJump,
}: {
  flow: TurnEntry[]
  firstVisible: number
  scrollRef: RefObject<HTMLDivElement | null>
  contentRef: RefObject<HTMLDivElement | null>
  onJump: (id: string, index: number) => void
}) {
  const links = useMemo(() => turnLinks(flow), [flow])
  const railRef = useRef<HTMLElement>(null)
  const [activeId, setActiveId] = useState<string>()
  const [focusedId, setFocusedId] = useState<string>()
  const lastId = links.at(-1)?.id
  // 本地分页可以从一轮的中间开始；用户消息尚未挂载时仍能标出当前轮。
  const leadingId = (links.findLast(({ index }) => index < firstVisible) ?? links[0])?.id
  const currentId = links.some(({ id }) => id === activeId) ? activeId : lastId
  const tabId = links.some(({ id }) => id === focusedId) ? focusedId : currentId

  useLayoutEffect(() => {
    const scroll = scrollRef.current
    const content = contentRef.current
    if (!scroll || !content || leadingId === undefined || lastId === undefined) return

    const update = () => {
      if (isAtBottom(scroll.scrollTop, scroll.scrollHeight, scroll.clientHeight, 1)) {
        setActiveId(lastId)
        return
      }
      const readingLine = scroll.getBoundingClientRect().top + Math.min(24, scroll.clientHeight / 3)
      let current = leadingId
      for (const anchor of content.querySelectorAll<HTMLElement>('[data-turn-anchor]')) {
        if (anchor.getBoundingClientRect().top > readingLine) break
        current = anchor.dataset.turnAnchor ?? current
      }
      setActiveId(current)
    }
    update()
    scroll.addEventListener('scroll', update, { passive: true })
    let frame = 0
    const resize = new ResizeObserver(() => {
      cancelAnimationFrame(frame)
      frame = requestAnimationFrame(update)
    })
    resize.observe(scroll)
    resize.observe(content)
    return () => {
      scroll.removeEventListener('scroll', update)
      resize.disconnect()
      cancelAnimationFrame(frame)
    }
  }, [contentRef, scrollRef, firstVisible, leadingId, lastId])

  useLayoutEffect(() => {
    const rail = railRef.current
    const button = rail?.querySelector<HTMLElement>('[aria-current="location"]')
    if (!rail || !button || rail.querySelector(':focus-visible')) return
    const top = button.offsetTop
    const bottom = top + button.offsetHeight
    if (top < rail.scrollTop) rail.scrollTop = top
    else if (bottom > rail.scrollTop + rail.clientHeight) rail.scrollTop = bottom - rail.clientHeight
  }, [currentId, links.length])

  const moveFocus = (event: KeyboardEvent<HTMLButtonElement>, position: number) => {
    const rail = railRef.current
    if (!rail || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return
    let next: number
    switch (event.key) {
      case 'ArrowUp':
        next = Math.max(0, position - 1)
        break
      case 'ArrowDown':
        next = Math.min(links.length - 1, position + 1)
        break
      case 'Home':
        next = 0
        break
      case 'End':
        next = links.length - 1
        break
      default:
        return
    }
    event.preventDefault()
    rail.querySelectorAll('button')[next]?.focus()
  }

  if (links.length === 0) return null

  return (
    <nav ref={railRef} aria-label={t('会话轮次')}
      className="absolute left-0 top-1/2 z-10 flex max-h-[min(100%,18rem)] w-6 -translate-y-1/2 flex-col items-center overflow-y-auto overscroll-contain py-0.5 [scrollbar-width:none]"
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget)) setFocusedId(undefined)
      }}
    >
      {links.map(({ id, index, prompt, reply }, position) => (
        <Tip key={id} side="right" className="w-72 max-w-[calc(100vw-3rem)] p-3"
          label={<>
            <p className="line-clamp-2 font-semibold">{prompt}</p>
            {reply && <p className="mt-1 line-clamp-3 text-qn-muted">{reply}</p>}
          </>}
        >
          <button
            type="button"
            aria-label={t('跳转到第 {index} 轮，{prompt}', { index: position + 1, prompt: excerpt(prompt, 64) })}
            aria-current={id === currentId ? 'location' : undefined}
            tabIndex={id === tabId ? 0 : -1}
            className="group grid size-5 shrink-0 place-items-center rounded-md hover:bg-qn-hover focus-visible:outline-offset-[-2px]"
            onClick={() => onJump(id, index)}
            onFocus={() => setFocusedId(id)}
            onKeyDown={(event) => moveFocus(event, position)}
          >
            <span aria-hidden="true" className={`h-0.5 rounded-full group-hover:w-4 group-hover:bg-qn-text ${id === currentId ? 'w-4 bg-qn-text' : 'w-2.5 bg-qn-muted'}`} />
          </button>
        </Tip>
      ))}
    </nav>
  )
}
