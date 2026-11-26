import { useId } from 'react'

/** 应用图标（与 branding/icon.svg 同一几何），内联渲染避免额外请求。 */
export function Logo({ size = 16, className = '' }: { size?: number; className?: string }) {
  // 同屏可能有多个实例，渐变 id 必须唯一。
  const gradientId = `qn-logo-${useId().replace(/:/g, '')}`
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
        <linearGradient id={gradientId} x1="0" y1="0" x2="512" y2="512" gradientUnits="userSpaceOnUse">
          <stop stopColor="#6EE7CE" />
          <stop offset="1" stopColor="#1F9C88" />
        </linearGradient>
      </defs>
      <rect width="512" height="512" rx="112" fill={`url(#${gradientId})`} />
      <rect x="96" y="344" width="320" height="64" rx="12" fill="#F3F6F8" />
      <path
        fill="#121415"
        d="M130 93H262Q264 93 267 95L385 194Q389 197 385 200L267 299Q264 301 262 301H130Q124 301 128 297L247 197L128 97Q124 93 130 93Z"
      />
    </svg>
  )
}
