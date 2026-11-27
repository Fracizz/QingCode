/** 应用图标（与 branding/icon.svg 同一几何，沿用旧版 QingCode 图标），内联渲染避免额外请求。 */
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
      <rect width="512" height="512" rx="112" fill="#121415" />
      <g transform="translate(256 256) scale(0.84) translate(-256 -250.5)">
        <rect x="96" y="344" width="320" height="64" rx="12" fill="#4ECDB5" />
        <path
          fill="#F3F6F8"
          d="M130 93H262Q264 93 267 95L385 194Q389 197 385 200L267 299Q264 301 262 301H130Q124 301 128 297L247 197L128 97Q124 93 130 93Z"
        />
      </g>
    </svg>
  )
}
