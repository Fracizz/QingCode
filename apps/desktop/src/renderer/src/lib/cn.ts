import { clsx, type ClassValue } from 'clsx'
import { twMerge } from 'tailwind-merge'

/** 合并条件 class，并让后写的 Tailwind 类覆盖冲突的前者（如调用方传入的 px-4 覆盖默认 px-2）。 */
export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs))
}
