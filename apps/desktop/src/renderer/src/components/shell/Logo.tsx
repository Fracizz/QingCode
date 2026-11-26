/** 应用图标（与 branding/icon.svg 同一几何：炭黑底 + 白色尖括号 + 青色光标条），内联渲染避免额外请求。 */
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
      <rect width="512" height="512" rx="112" fill="#1C1F22" />
      <rect x="4" y="4" width="504" height="504" rx="108" stroke="#33383D" strokeWidth="8" />
      <path
        d="M136 112H252L372 214L252 316H136L256 214Z"
        fill="#F3F4F6"
        stroke="#F3F4F6"
        strokeWidth="14"
        strokeLinejoin="round"
      />
      <rect x="136" y="358" width="236" height="46" rx="8" fill="#4ECDB5" />
    </svg>
  )
}
