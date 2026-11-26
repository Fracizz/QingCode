import { useRef } from 'react'
import { X } from 'lucide-react'
import { IconButton } from './ui'

export function MessageImage({ src, label }: { src: string; label: string }) {
  const previewRef = useRef<HTMLDialogElement>(null)

  return (
    <>
      <button
        type="button"
        aria-label={`查看${label}`}
        aria-haspopup="dialog"
        className="max-w-[min(100%,16rem)] cursor-zoom-in overflow-hidden rounded-xl border border-qn-border focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-qn-accent"
        onClick={() => previewRef.current?.showModal()}
      >
        <img src={src} alt={label} className="max-h-48 max-w-full object-contain" />
      </button>
      <dialog
        ref={previewRef}
        aria-label={`${label}预览`}
        className="qn-no-drag fixed inset-0 m-auto max-h-none max-w-none bg-transparent px-0 py-10 backdrop:bg-black/80"
        onClick={(event) => {
          if (event.target === event.currentTarget) event.currentTarget.close()
        }}
      >
        <IconButton
          label="关闭图片预览"
          tooltip={false}
          className="absolute right-0 top-0 bg-qn-panel text-qn-text"
          onClick={() => previewRef.current?.close()}
        >
          <X size={16} />
        </IconButton>
        <img
          src={src}
          alt={label}
          loading="lazy"
          className="max-h-[calc(100vh-6rem)] max-w-[calc(100vw-3rem)] object-contain"
        />
      </dialog>
    </>
  )
}
