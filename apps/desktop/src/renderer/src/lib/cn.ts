import { clsx, type ClassValue } from 'clsx'
import { extendTailwindMerge } from 'tailwind-merge'

// 自定义字号 token（styles.css 的 --text-ui-*）不是 t-shirt 尺寸，tailwind-merge 默认会把 text-ui-sm 归为颜色类，
// 与 text-qn-muted 同组时会被误删，所以登记进 text 主题。
const twMerge = extendTailwindMerge({
  extend: {
    theme: {
      text: ['ui', 'ui-2xs', 'ui-xs', 'ui-sm', 'ui-md', 'ui-lg'],
    },
  },
})

/** 合并条件 class，并让后写的 Tailwind 类覆盖冲突的前者（如调用方传入的 px-4 覆盖默认 px-2）。 */
export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs))
}
