export function ProgressRing({ percent, size, color = 'currentColor' }: { percent: number; size: number; color?: string }) {
  return (
    <svg width={size} height={size} viewBox="0 0 13 13" className="shrink-0 -rotate-90" aria-hidden="true">
      <circle cx="6.5" cy="6.5" r="5" fill="none" stroke={color} strokeWidth="1.5" opacity="0.25" />
      <circle
        cx="6.5"
        cy="6.5"
        r="5"
        pathLength="100"
        fill="none"
        stroke={color}
        strokeWidth="1.5"
        strokeDasharray={`${percent} 100`}
      />
    </svg>
  )
}
