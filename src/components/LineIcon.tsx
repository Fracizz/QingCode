import type { ReactNode } from 'react'
import type { LucideIcon } from 'lucide-react'

export interface LineIconProps {
  /** lucide 图标组件；需要自定义内容（如带动画的图标、按钮）时改用 children。 */
  icon?: LucideIcon
  size?: number
  className?: string
  children?: ReactNode
}

/**
 * 提示行前后的图标（Toast、内联错误 / 状态提示等）：外层高度取 1lh，图标在其中垂直居中，
 * 单行时与文字水平对齐，多行时对齐首行，不必再用 mt-0.5 之类的偏移按字号凑。
 *
 * 用法：放在 `flex items-start` 的行里，并把文字的字号与行高（text-* / leading-*）写在这一行上，
 * 1lh 才能取到与文字相同的行高。
 */
export default function LineIcon({ icon: Icon, size = 16, className = '', children }: LineIconProps) {
  return (
    <span className={`flex h-[1lh] shrink-0 items-center ${className}`} aria-hidden={children ? undefined : true}>
      {Icon ? <Icon size={size} /> : children}
    </span>
  )
}
