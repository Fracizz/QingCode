interface Props {
  size?: number
  className?: string
}

/** Inline app mark — keep in sync with public/app-icon.svg */
export default function AppIcon({ size = 16, className }: Props) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 512 512"
      width={size}
      height={size}
      fill="none"
      aria-hidden="true"
      className={className}
    >
      <rect width="512" height="512" fill="#131010" />
      <path d="M224 220H288V272H224V220Z" fill="#4A6864" />
      <path
        fillRule="evenodd"
        clipRule="evenodd"
        fill="#FFFFFF"
        d="M108 272C108 400 176 444 256 444C336 444 404 400 404 272H356C356 368 314 400 256 400C198 400 156 368 156 272H108Z"
      />
      <path
        fill="#FFFFFF"
        d="M172 136H220L320 208L220 280H172L272 208L172 136Z"
      />
    </svg>
  )
}
