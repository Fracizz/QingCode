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
      <path fill="#4ECDB5" d="M248 403.52A150 150 0 1 1 372.59 316H301.24A90 90 0 1 0 248 343.2Z" />
      <rect x="268" y="336" width="152" height="56" rx="12" fill="#FFFFFF" />
    </svg>
  )
}
