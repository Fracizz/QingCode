import { ShieldQuestionMark } from 'lucide-react'
import { t } from '@qn/codex-client'
import { Modal } from './ui'

/** 新增项目时询问是否信任：未信任的项目禁用运行配置，Agent 只能用默认权限。 */
export function TrustProjectDialog({
  path,
  onChoose,
  onClose,
}: {
  path: string
  onChoose: (trusted: boolean) => void
  onClose: () => void
}) {
  return (
    <Modal
      title={t('信任此项目？')}
      width="max-w-lg"
      onClose={onClose}
      footer={
        <div className="flex justify-end gap-2">
          {/* 默认焦点放在「不信任」，避免误按回车直接授予信任。 */}
          <button className="qn-button-subtle" type="button" autoFocus onClick={() => onChoose(false)}>
            {t('暂不信任')}
          </button>
          <button className="qn-button" type="button" onClick={() => onChoose(true)}>
            {t('信任')}
          </button>
        </div>
      }
    >
      <div className="space-y-3">
        <div className="flex items-start gap-2 text-ui-sm leading-5 text-qn-text">
          <ShieldQuestionMark size={16} className="mt-0.5 shrink-0 text-qn-warn" aria-hidden />
          <span>{t('只信任你了解来源的项目。未信任的项目不能启动运行配置，Agent 只能以「请求批准」模式工作。之后可在项目菜单中更改。')}</span>
        </div>
        <div className="break-all rounded-md border border-qn-border bg-qn-code px-3 py-2 font-mono text-ui-sm text-qn-muted">{path}</div>
      </div>
    </Modal>
  )
}
