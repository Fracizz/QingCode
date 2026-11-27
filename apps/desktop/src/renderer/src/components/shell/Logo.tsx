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
      <path fill="#4ECDB5" d="M256 391.58A145 145 0 1 1 376.08 309H310.24A90 90 0 1 0 256 336.33Z" />
      <rect x="276" y="329" width="150" height="52" rx="11" fill="#FFFFFF" />
    </svg>
  )
}
