import { ShieldAlert } from 'lucide-react'
import type { HostKeyPrompt } from '../../../shared/backendApi'
import { Modal } from './ui'

export function HostKeyDialog({
  prompt,
  onRespond,
}: {
  prompt: HostKeyPrompt
  onRespond: (accept: boolean) => void
}) {
  const changed = prompt.kind === 'changed'
  return (
    <Modal
      title={changed ? '主机指纹发生变化' : '首次连接主机'}
      width="max-w-xl"
      footer={
        <div className="flex justify-end gap-2">
          <button className="qn-button" type="button" autoFocus={changed} onClick={() => onRespond(false)}>
            取消
          </button>
          <button
            className={changed ? 'qn-button-subtle border-qn-danger/60 text-qn-danger' : 'qn-button'}
            type="button"
            onClick={() => onRespond(true)}
          >
            {changed ? '仍然信任并连接' : '信任并连接'}
          </button>
        </div>
      }
    >
      <div className="space-y-3">
        <div className="flex items-start gap-2 text-xs leading-5">
          <ShieldAlert size={16} className={changed ? 'text-qn-danger' : 'text-amber-300'} />
          <span className={changed ? 'text-qn-danger' : 'text-qn-text'}>
            {changed
              ? '该主机的密钥与已保存的指纹不一致，可能存在中间人攻击。除非你确认主机已重装或更换密钥，否则请取消。'
              : '首次连接该主机，请核对指纹后再信任。'}
          </span>
        </div>
        <div className="rounded-lg border border-qn-border bg-qn-inset p-3 text-xs">
          <div className="text-qn-muted">
            主机：{prompt.host}:{prompt.port}
          </div>
          {changed && prompt.previous && (
            <div className="mt-2">
              <div className="text-qn-muted">已保存的指纹</div>
              <code className="mt-1 block break-all font-mono text-[12px] text-qn-danger">
                {prompt.previous}
              </code>
            </div>
          )}
          <div className="mt-2">
            <div className="text-qn-muted">{changed ? '本次收到的指纹' : '主机指纹（SHA256）'}</div>
            <code className="mt-1 block break-all font-mono text-[12px] text-qn-text">
              {prompt.fingerprint}
            </code>
          </div>
        </div>
      </div>
    </Modal>
  )
}
