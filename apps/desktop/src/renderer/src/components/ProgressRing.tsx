export function ProgressRing({ percent, size, fillBounds = false }: {
  percent: number
  size: number
  fillBounds?: boolean
}) {
  const diameter = fillBounds ? size : 13
  const center = diameter / 2
  const strokeWidth = fillBounds ? 2 : 1.5
  const radius = fillBounds ? center - strokeWidth / 2 : 5
  return (
    <svg width={size} height={size} viewBox={`0 0 ${diameter} ${diameter}`} className="shrink-0 -rotate-90"
      aria-hidden="true" fill="none" stroke="currentColor" strokeWidth={strokeWidth}>
      <circle cx={center} cy={center} r={radius} opacity="0.25" />
      <circle
        cx={center}
        cy={center}
        r={radius}
        pathLength="100"
        strokeDasharray={`${percent} 100`}
      />
    </svg>
  )
}
