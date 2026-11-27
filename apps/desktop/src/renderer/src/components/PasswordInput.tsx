import { Eye, EyeOff } from 'lucide-react'
import { useState, type ComponentPropsWithoutRef } from 'react'
import { t } from '@qn/codex-client'
import { cn } from '../lib/cn'

/** 密码/口令输入框：右侧眼睛图标切换明文显示；默认隐藏，组件卸载即恢复隐藏。 */
export function PasswordInput({ className, ...props }: Omit<ComponentPropsWithoutRef<'input'>, 'type'>) {
  const [visible, setVisible] = useState(false)
  return (
    <div className="relative">
      <input {...props} type={visible ? 'text' : 'password'} className={cn('qn-input pr-9', className)} />
      <button
        type="button"
        tabIndex={-1}
        aria-label={visible ? t('隐藏密码') : t('显示密码')}
        title={visible ? t('隐藏密码') : t('显示密码')}
        onMouseDown={(event) => event.preventDefault()}
        onClick={() => setVisible((value) => !value)}
        className="absolute inset-y-0 right-1 my-auto inline-flex h-7 w-7 items-center justify-center rounded-md text-qn-muted hover:bg-qn-hover hover:text-qn-text"
      >
        {visible ? <EyeOff size={15} /> : <Eye size={15} />}
      </button>
    </div>
  )
}
