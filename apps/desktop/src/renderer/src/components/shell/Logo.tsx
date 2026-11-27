/** 应用图标（与 branding/icon.svg 同一几何与配色），内联渲染避免额外请求。纯色扁平，无渐变，因此无需唯一 id。 */
export function Logo({ size = 16, className = '' }: { size?: number; className?: string }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 512 512"
      fill="none"
      aria-hidden="true"
      className={`shrink-0 ${className}`}
    >
      <rect width="512" height="512" rx="112" fill="#0E0F11" />
      <path fill="#4ECDB5" d="M250 387.62A132 132 0 1 1 359.53 312H299.9A82 82 0 1 0 250 337.39Z" />
      <rect x="268" y="330" width="136" height="48" rx="10" fill="#FFFFFF" />
    </svg>
  )
}
