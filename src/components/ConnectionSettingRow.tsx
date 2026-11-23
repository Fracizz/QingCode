import type { ReactNode } from 'react'

/** 远程连接详情里的一行设置：左侧标题与说明，右侧控件；窄窗时控件换到下一行。 */
export default function ConnectionSettingRow({ title, description, children, footer }: {
  title: ReactNode
  description?: ReactNode
  children: ReactNode
  /** 控件下方的补充信息（提示、暂停原因等），占满整行。 */
  footer?: ReactNode
}) {
  return <div className="px-3 py-2.5">
    <div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-2">
      <div className="min-w-0 flex-1 basis-56">
        <div className="text-ui text-fg">{title}</div>
        {description && <p className="mt-0.5 text-ui-sm leading-[var(--ui-line-height)] text-fg-muted">{description}</p>}
      </div>
      <div className="w-full shrink-0 @lg:w-60">{children}</div>
    </div>
    {footer}
  </div>
}
