import type { ComponentProps, ReactNode } from 'react'
import { Check, ChevronDown } from 'lucide-react'
import { ContextMenu, DropdownMenu, Popover, Select as RadixSelect, Tabs, Tooltip } from 'radix-ui'
import { cn } from '../lib/cn'

/*
 * Radix Primitives 的薄封装：交互、键盘导航、焦点管理、读屏语义交给 Radix，外观统一用 qn-* token。
 * 浮层都 Portal 到 body，所以必须带 qn-no-drag，否则落在标题栏拖动区上会点不中。
 */

/** 浮层统一外观（见 styles.css 的 .qn-surface-float）；导出给非 Radix 浮层（斜杠菜单、划词工具条、右键菜单）复用。 */
export const floatSurface = 'qn-no-drag qn-float qn-surface-float z-50 text-ui'

export const menuItemClass =
  'flex min-h-8 cursor-default select-none items-center gap-2.5 rounded-lg px-2.5 py-1 outline-none data-[disabled]:pointer-events-none data-[disabled]:opacity-40 data-[highlighted]:bg-qn-hover data-[state=open]:bg-qn-hover'

const menuSeparatorClass = 'mx-1 my-1 h-px bg-qn-border'

type MenuItemProps = { icon?: ReactNode; hint?: ReactNode; danger?: boolean; children?: ReactNode }

export function MenuItemContent({ icon, hint, danger, children }: MenuItemProps) {
  return (
    <>
      {icon && <span className={cn('flex w-4 shrink-0 justify-center', !danger && 'text-qn-muted')}>{icon}</span>}
      <span className="min-w-0 flex-1 truncate">{children}</span>
      {hint && <span className="shrink-0 text-ui-sm text-qn-dim">{hint}</span>}
    </>
  )
}

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
}: ComponentProps<typeof DropdownMenu.Item> & MenuItemProps) {
  return (
    <DropdownMenu.Item
      className={cn(menuItemClass, danger ? 'text-qn-danger' : 'text-qn-text', className)}
      {...props}
    >
      <MenuItemContent icon={icon} hint={hint} danger={danger}>{children}</MenuItemContent>
    </DropdownMenu.Item>
  )
}

export function MenuLabel({ className, ...props }: ComponentProps<typeof DropdownMenu.Label>) {
  return <DropdownMenu.Label className={cn('px-2.5 pb-1 pt-1.5 text-ui-sm text-qn-dim', className)} {...props} />
}

export function MenuSeparator({ className, ...props }: ComponentProps<typeof DropdownMenu.Separator>) {
  return <DropdownMenu.Separator className={cn(menuSeparatorClass, className)} {...props} />
}

export function ContextMenuContent({ className, ...props }: ComponentProps<typeof ContextMenu.Content>) {
  return (
    <ContextMenu.Portal>
      <ContextMenu.Content className={cn(floatSurface, 'min-w-48 p-1', className)} {...props} />
    </ContextMenu.Portal>
  )
}

export function ContextMenuItem({
  className,
  icon,
  hint,
  danger,
  children,
  ...props
}: ComponentProps<typeof ContextMenu.Item> & MenuItemProps) {
  return (
    <ContextMenu.Item className={cn(menuItemClass, danger ? 'text-qn-danger' : 'text-qn-text', className)} {...props}>
      <MenuItemContent icon={icon} hint={hint} danger={danger}>{children}</MenuItemContent>
    </ContextMenu.Item>
  )
}

export function ContextMenuSeparator({ className, ...props }: ComponentProps<typeof ContextMenu.Separator>) {
  return <ContextMenu.Separator className={cn(menuSeparatorClass, className)} {...props} />
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
  align,
  className,
  children,
}: {
  label: ReactNode
  side?: 'top' | 'bottom' | 'left' | 'right'
  align?: 'start' | 'center' | 'end'
  className?: string
  children: ReactNode
}) {
  return (
    <Tooltip.Root>
      <Tooltip.Trigger asChild>{children}</Tooltip.Trigger>
      <Tooltip.Portal>
        <Tooltip.Content
          side={side}
          align={align}
          sideOffset={6}
          collisionPadding={8}
          className={cn('qn-no-drag qn-float qn-surface-float z-[60] max-w-[min(20rem,calc(100vw-1rem))] rounded-lg px-2.5 py-1.5 text-ui-sm leading-4 whitespace-normal wrap-anywhere', className)}
        >
          {label}
        </Tooltip.Content>
      </Tooltip.Portal>
    </Tooltip.Root>
  )
}

// ---------- 下拉选择 ----------

export type SelectOption = { value: string; label: ReactNode; description?: ReactNode; disabled?: boolean }
export type SelectGroup = { label?: ReactNode; options: SelectOption[] }

/**
 * 下拉选择（Radix Select），替代原生 <select>：原生下拉在 Windows 上是系统白底高亮、圆角与字号都不受控。
 * 触发器外观与 .qn-input 一致；下拉面板用浮层表面，宽度跟随触发器。传 options 或分组 groups 二选一。
 */
export function Select({
  value,
  onValueChange,
  options,
  groups,
  placeholder = '请选择',
  disabled,
  className,
  'aria-label': ariaLabel,
}: {
  value: string
  onValueChange: (value: string) => void
  options?: SelectOption[]
  groups?: SelectGroup[]
  placeholder?: string
  disabled?: boolean
  className?: string
  'aria-label'?: string
}) {
  const list: SelectGroup[] = groups ?? [{ options: options ?? [] }]
  return (
    <RadixSelect.Root value={value || undefined} onValueChange={onValueChange} disabled={disabled}>
      <RadixSelect.Trigger
        aria-label={ariaLabel}
        className={cn(
          'qn-input flex items-center justify-between gap-2 text-left data-[placeholder]:text-qn-dim data-[state=open]:border-qn-outline-hover disabled:cursor-not-allowed disabled:opacity-55',
          className,
        )}
      >
        <span className="min-w-0 flex-1 truncate">
          <RadixSelect.Value placeholder={placeholder} />
        </span>
        <RadixSelect.Icon className="shrink-0 text-qn-muted">
          <ChevronDown size={15} />
        </RadixSelect.Icon>
      </RadixSelect.Trigger>
      <RadixSelect.Portal>
        <RadixSelect.Content
          position="popper"
          sideOffset={4}
          collisionPadding={8}
          className={cn(
            floatSurface,
            'max-h-[min(320px,var(--radix-select-content-available-height))] w-[var(--radix-select-trigger-width)] overflow-hidden',
          )}
        >
          <RadixSelect.Viewport className="qn-scroll p-1">
            {list.map((group, index) => (
              <RadixSelect.Group key={index}>
                {index > 0 && <RadixSelect.Separator className={menuSeparatorClass} />}
                {group.label && (
                  <RadixSelect.Label className="px-2.5 pb-1 pt-1.5 text-ui-sm text-qn-dim">{group.label}</RadixSelect.Label>
                )}
                {group.options.map((option) => (
                  <RadixSelect.Item
                    key={option.value}
                    value={option.value}
                    disabled={option.disabled}
                    className="relative flex min-h-8 cursor-default select-none items-center gap-2 rounded-lg py-1.5 pl-2.5 pr-8 text-ui text-qn-text outline-none data-[disabled]:pointer-events-none data-[disabled]:opacity-40 data-[highlighted]:bg-qn-hover"
                  >
                    <span className="min-w-0 flex-1">
                      <RadixSelect.ItemText>{option.label}</RadixSelect.ItemText>
                      {option.description && <span className="block text-ui-sm text-qn-dim">{option.description}</span>}
                    </span>
                    <RadixSelect.ItemIndicator className="absolute right-2.5 text-qn-text">
                      <Check size={14} />
                    </RadixSelect.ItemIndicator>
                  </RadixSelect.Item>
                ))}
              </RadixSelect.Group>
            ))}
          </RadixSelect.Viewport>
        </RadixSelect.Content>
      </RadixSelect.Portal>
    </RadixSelect.Root>
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
        'h-8 rounded-lg px-3 text-ui text-qn-muted outline-none hover:text-qn-text focus-visible:ring-1 focus-visible:ring-qn-outline-hover data-[state=active]:bg-qn-hover data-[state=active]:text-qn-text',
        className,
      )}
      {...props}
    />
  )
}

export function TabsContent({ className, ...props }: ComponentProps<typeof Tabs.Content>) {
  return <Tabs.Content className={cn('outline-none', className)} {...props} />
}
