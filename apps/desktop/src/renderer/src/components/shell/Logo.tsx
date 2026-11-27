import { useId } from 'react'

/** 应用图标（与 branding/icon.svg 同一几何与渐变），内联渲染避免额外请求。 */
export function Logo({ size = 16, className = '' }: { size?: number; className?: string }) {
  // 同页可能有多个 Logo，渐变 id 需唯一，否则某个实例被隐藏时其它实例会丢失填充。
  const id = useId()
  const tile = `${id}-tile`
  const rim = `${id}-rim`
  const chevron = `${id}-chevron`
  const cursor = `${id}-cursor`
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 512 512"
      fill="none"
      aria-hidden="true"
      className={`shrink-0 ${className}`}
    >
      <defs>
        <linearGradient id={tile} x1="0" y1="0" x2="0" y2="512" gradientUnits="userSpaceOnUse">
          <stop offset="0" stopColor="#0F1114" />
          <stop offset="1" stopColor="#000000" />
        </linearGradient>
        <linearGradient id={rim} x1="0" y1="0" x2="0" y2="512" gradientUnits="userSpaceOnUse">
          <stop offset="0" stopColor="#FFFFFF" stopOpacity="0.18" />
          <stop offset="0.45" stopColor="#FFFFFF" stopOpacity="0" />
        </linearGradient>
        <linearGradient id={chevron} x1="130" y1="93" x2="389" y2="301" gradientUnits="userSpaceOnUse">
          <stop offset="0" stopColor="#FFFFFF" />
          <stop offset="0.5" stopColor="#F2F4F6" />
          <stop offset="1" stopColor="#D3D9DF" />
        </linearGradient>
        <linearGradient id={cursor} x1="0" y1="344" x2="0" y2="408" gradientUnits="userSpaceOnUse">
          <stop offset="0" stopColor="#7CF5DC" />
          <stop offset="1" stopColor="#25C6A8" />
        </linearGradient>
      </defs>
      <rect width="512" height="512" rx="112" fill={`url(#${tile})`} />
      <rect x="2" y="2" width="508" height="508" rx="110" stroke={`url(#${rim})`} strokeWidth="4" />
      <g transform="translate(256 256) scale(0.92) translate(-256 -250.5)">
        <rect x="96" y="344" width="320" height="64" rx="12" fill={`url(#${cursor})`} />
        <path
          fill={`url(#${chevron})`}
          d="M130 93H262Q264 93 267 95L385 194Q389 197 385 200L267 299Q264 301 262 301H130Q124 301 128 297L247 197L128 97Q124 93 130 93Z"
        />
      </g>
    </svg>
  )
}
