import { useEffect, useRef, useState } from 'react'
import { File as FileIcon, Folder } from 'lucide-react'
import { validateEntryName } from '../store/promptStore'
import { useI18n } from '../lib/i18n'

interface Props {
  directory: boolean
  depth: number
  /** When set, acts as inline rename (prefilled, selects stem). */
  initialName?: string
  onSubmit: (name: string) => void
  onCancel: () => void
}

/** VS Code / IDEA-style inline name input in the explorer tree (create or rename). */
export default function InlineCreateRow({
  directory,
  depth,
  initialName = '',
  onSubmit,
  onCancel,
}: Props) {
  const { t } = useI18n()
  const inputRef = useRef<HTMLInputElement>(null)
  const submittingRef = useRef(false)
  const [value, setValue] = useState(initialName)
  const [error, setError] = useState<string | null>(null)
  const renaming = Boolean(initialName)

  useEffect(() => {
    const timer = window.setTimeout(() => {
      const input = inputRef.current
      if (!input) return
      input.focus()
      if (renaming) {
        const dot = initialName.lastIndexOf('.')
        const end = !directory && dot > 0 ? dot : initialName.length
        input.setSelectionRange(0, end)
      }
    }, 0)
    return () => window.clearTimeout(timer)
  }, [directory, initialName, renaming])

  const submit = () => {
    const err = validateEntryName(value)
    if (err) {
      setError(err)
      inputRef.current?.focus()
      return
    }
    submittingRef.current = true
    onSubmit(value.trim())
  }

  const pad = depth * 12 + 8

  return (
    <div
      className="flex items-center gap-1 pr-2 py-[3px] text-[13px] select-none bg-bg-active/60"
      style={{ paddingLeft: pad }}
    >
      <span className="w-[14px] flex-shrink-0" />
      {directory ? (
        <Folder size={15} className="text-accent flex-shrink-0" />
      ) : (
        <FileIcon size={14} className="text-fg-muted flex-shrink-0" />
      )}
      <input
        ref={inputRef}
        type="text"
        value={value}
        onChange={event => {
          setValue(event.target.value)
          if (error) setError(null)
        }}
        onKeyDown={event => {
          if (event.key === 'Enter') {
            event.preventDefault()
            submit()
          }
          if (event.key === 'Escape') {
            event.preventDefault()
            onCancel()
          }
        }}
        onBlur={() => {
          window.setTimeout(() => {
            if (!submittingRef.current) onCancel()
          }, 80)
        }}
        className={`flex-1 min-w-0 h-[22px] px-1.5 text-[13px] bg-bg border rounded-sm outline-none text-fg
          ${error ? 'border-danger' : 'border-accent'}`}
        aria-label={
          renaming
            ? directory
              ? t('文件夹新名称')
              : t('文件新名称')
            : directory
              ? t('新建文件夹名称')
              : t('新建文件名称')
        }
        aria-invalid={error ? true : undefined}
      />
    </div>
  )
}
