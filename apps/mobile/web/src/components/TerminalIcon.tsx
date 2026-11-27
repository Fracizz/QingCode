/**
 * 方框终端图标，与电脑版 TerminalIcon 一致。运行中时提示符后的光标缓慢闪烁表示进行中，
 * 比转圈更安静；系统要求减少动效时保持静止。
 */
export function TerminalIcon({ running = false, className = '' }: { running?: boolean; className?: string }) {
  return (
    <svg
      width={14}
      height={14}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      className={`shrink-0 ${running ? 'text-qn-accent' : ''} ${className}`}
    >
      <rect width="18" height="18" x="3" y="3" rx="2" />
      <path d="m7 11 2-2-2-2" className={running ? 'qn-terminal-prompt' : undefined} />
      <path d="M11 13h4" className={running ? 'qn-terminal-cursor' : undefined} />
    </svg>
  )
}
