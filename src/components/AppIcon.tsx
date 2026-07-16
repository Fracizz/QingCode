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
      <path d="M212 232H308V328H212V232Z" fill="#4A6864" />
      <path
        fillRule="evenodd"
        clipRule="evenodd"
        fill="#F1ECEC"
        d="M80 268C80 420 164 472 256 472C348 472 432 420 432 268H372C372 388 320 424 256 424C192 424 140 388 140 268H80Z"
      />
      <path
        fill="#F1ECEC"
        d="M160 168H236L348 256L236 344H160L268 256L160 168Z"
      />
    </svg>
  )
}
