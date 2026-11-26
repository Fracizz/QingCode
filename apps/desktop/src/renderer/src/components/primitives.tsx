import type { ComponentProps, ReactNode } from 'react'
import { DropdownMenu, Popover, Tabs, Tooltip } from 'radix-ui'
import { cn } from '../lib/cn'

/*
 * Radix Primitives 的薄封装：交互、键盘导航、焦点管理、读屏语义交给 Radix，外观统一用 qn-* token。
 * 浮层都 Portal 到 body，所以必须带 qn-no-drag，否则落在标题栏拖动区上会点不中。
 */

const floatSurface =
  'qn-no-drag qn-float z-50 rounded-xl border border-qn-border-strong bg-qn-elevated text-[13px] text-qn-text shadow-[0_12px_40px_rgba(0,0,0,0.45)]'

// ---------- 下拉菜单 ----------

export const Menu = DropdownMenu.Root
export const MenuTrigger = DropdownMenu.Trigger
export const MenuGroup = DropdownMenu.Group

export function MenuContent({
  className,
  sideOffset = 6,
  align = 'start',
  ...props
}: ComponentProps<typeof DropdownMenu.Content>) {
  return (
    <DropdownMenu.Portal>
      <DropdownMenu.Content
        sideOffset={sideOffset}
        align={align}
        collisionPadding={8}
        className={cn(floatSurface, 'min-w-48 p-1', className)}
        {...props}
      />
    </DropdownMenu.Portal>
  )
}

export function MenuItem({
  className,
  icon,
  hint,
  danger,
  children,
  ...props
}: ComponentProps<typeof DropdownMenu.Item> & { icon?: ReactNode; hint?: ReactNode; danger?: boolean }) {
  return (
    <DropdownMenu.Item
      className={cn(
        'flex min-h-8 cursor-default select-none items-center gap-2.5 rounded-lg px-2.5 py-1 outline-none data-[disabled]:pointer-events-none data-[disabled]:opacity-40 data-[highlighted]:bg-qn-hover',
        danger ? 'text-qn-danger' : 'text-qn-text',
        className,
      )}
      {...props}
    >
      {icon && <span className={cn('flex w-4 shrink-0 justify-center', !danger && 'text-qn-muted')}>{icon}</span>}
      <span className="min-w-0 flex-1 truncate">{children}</span>
      {hint && <span className="shrink-0 text-[12px] text-qn-dim">{hint}</span>}
    </DropdownMenu.Item>
  )
}

export function MenuLabel({ className, ...props }: ComponentProps<typeof DropdownMenu.Label>) {
  return <DropdownMenu.Label className={cn('px-2.5 pb-1 pt-1.5 text-[12px] text-qn-dim', className)} {...props} />
}

export function MenuSeparator({ className, ...props }: ComponentProps<typeof DropdownMenu.Separator>) {
  return <DropdownMenu.Separator className={cn('mx-1 my-1 h-px bg-qn-border', className)} {...props} />
}

// ---------- 弹出面板 ----------

export const PopoverRoot = Popover.Root
export const PopoverTrigger = Popover.Trigger
export const PopoverAnchor = Popover.Anchor
export const PopoverClose = Popover.Close

export function PopoverContent({
  className,
  sideOffset = 6,
  align = 'start',
  ...props
}: ComponentProps<typeof Popover.Content>) {
  return (
    <Popover.Portal>
      <Popover.Content
        sideOffset={sideOffset}
        align={align}
        collisionPadding={8}
        className={cn(floatSurface, 'outline-none', className)}
        {...props}
      />
    </Popover.Portal>
  )
}

// ---------- 提示 ----------

export const TooltipProvider = Tooltip.Provider

/** 悬停提示，替代原生 title（原生提示延迟长、样式不可控）。children 必须是能接收 ref 的单个元素。 */
export function Tip({
  label,
  side = 'top',
  children,
}: {
  label: ReactNode
  side?: 'top' | 'bottom' | 'left' | 'right'
  children: ReactNode
}) {
  return (
    <Tooltip.Root>
      <Tooltip.Trigger asChild>{children}</Tooltip.Trigger>
      <Tooltip.Portal>
        <Tooltip.Content
          side={side}
          sideOffset={6}
          collisionPadding={8}
          className="qn-no-drag qn-float z-[60] max-w-xs rounded-md border border-qn-border-strong bg-qn-elevated px-2 py-1 text-[12px] text-qn-text shadow-lg"
        >
          {label}
        </Tooltip.Content>
      </Tooltip.Portal>
    </Tooltip.Root>
  )
}

// ---------- 标签页 ----------

export const TabsRoot = Tabs.Root

export function TabsList({ className, ...props }: ComponentProps<typeof Tabs.List>) {
  return <Tabs.List className={cn('flex items-center gap-1', className)} {...props} />
}

export function TabsTrigger({ className, ...props }: ComponentProps<typeof Tabs.Trigger>) {
  return (
    <Tabs.Trigger
      className={cn(
        'h-8 rounded-lg px-3 text-[13px] text-qn-muted outline-none hover:text-qn-text focus-visible:ring-1 focus-visible:ring-qn-accent data-[state=active]:bg-qn-hover data-[state=active]:text-qn-text',
        className,
      )}
      {...props}
    />
  )
}

export function TabsContent({ className, ...props }: ComponentProps<typeof Tabs.Content>) {
  return <Tabs.Content className={cn('outline-none', className)} {...props} />
}
