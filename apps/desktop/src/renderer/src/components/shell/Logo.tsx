/** 应用图标（与 branding/icon.svg 同一几何：纯色青底 + 白色 ">_"），内联渲染避免额外请求。 */
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
      <rect width="512" height="512" rx="112" fill="#13A68E" />
      <g stroke="#FFFFFF" strokeWidth="46" strokeLinecap="round" strokeLinejoin="round">
        <path d="M150 168L242 256L150 344" />
        <path d="M282 344H366" />
      </g>
    </svg>
  )
}
