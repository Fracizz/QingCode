import { Fragment } from 'react'
import type { InfoTipDetails } from '../lib/infoTip'

const STATUS_TONE: Record<NonNullable<InfoTipDetails['status']>['tone'], string> = {
  muted: 'text-fg-muted',
  ok: 'text-ok',
  warn: 'text-warn',
  danger: 'text-danger',
}

/** Tooltip 的结构化内容：项目和终端的悬停详情共用，保持同样的版式。 */
export default function InfoTipCard({ title, status, rows }: InfoTipDetails) {
  return (
    <div
      data-info-tip-card
      className="min-w-[220px] max-w-[min(420px,calc(100vw-32px))] whitespace-normal p-3 text-ui-sm"
    >
      <div className="flex items-baseline justify-between gap-4">
        <span className="min-w-0 break-words text-ui font-medium text-fg">{title}</span>
        {status && (
          <span className={`flex-shrink-0 text-ui-xs ${STATUS_TONE[status.tone]}`}>{status.text}</span>
        )}
      </div>
      {rows.length > 0 && (
        <dl className="mt-2 grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1 border-t border-border pt-2">
          {rows.map(row => (
            <Fragment key={row.label}>
              <dt className="text-fg-muted">{row.label}</dt>
              <dd className={`break-all text-fg ${row.mono ? 'font-mono' : ''}`}>{row.value}</dd>
            </Fragment>
          ))}
        </dl>
      )}
    </div>
  )
}
