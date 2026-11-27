import { useEffect, useState } from 'react'
import { Smartphone } from 'lucide-react'
import { MobileSettingsDialog } from '../../components/MobileSettings'
import { Badge, Spinner } from '../../components/ui'
import { gatewayStatus, groupFingerprint } from '../../lib/mobileSettings'
import { useMobile } from '../../store/mobile'
import { InfoBlock } from './fields'

/**
 * 只读包装：原 MobileSettings.tsx 只导出对话框形态，这里展示摘要并在需要时打开原对话框，
 * 不修改原文件、也不复制它的表单逻辑。
 */
export function MobileSection() {
  const settings = useMobile((state) => state.settings)
  const devices = useMobile((state) => state.devices)
  const busy = useMobile((state) => state.busy)
  const error = useMobile((state) => state.error)
  const load = useMobile((state) => state.load)
  const [manageOpen, setManageOpen] = useState(false)

  useEffect(() => {
    void load()
  }, [load])

  const status = gatewayStatus(settings)

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2 rounded-xl border border-qn-border bg-qn-fg/[0.02] px-3 py-2.5">
        <Smartphone size={16} className="shrink-0 text-qn-accent" />
        <span className="text-[13px]">手机网关</span>
        <Badge tone={status.tone}>{status.label}</Badge>
        <span className="font-mono text-[12px] text-qn-dim">0.0.0.0:{settings?.port ?? 38500}</span>
        <span className="text-[12px] text-qn-dim">已配对 {devices.length} 台设备</span>
        <span className="min-w-0 flex-1" />
        {busy && <Spinner label={busy} />}
        <button type="button" className="qn-button px-2.5 py-1 text-[12px]" onClick={() => setManageOpen(true)}>
          打开手机连接设置
        </button>
      </div>

      {status.detail && <p className="text-[12px] text-qn-muted">{status.detail}</p>}
      {error && <p className="text-[12px] text-qn-danger">{error}</p>}

      <InfoBlock title="证书指纹（SHA-256）">
        <div className="break-all font-mono text-[12px]">
          {settings?.fingerprint ? groupFingerprint(settings.fingerprint) : '尚未生成'}
        </div>
        <p className="mt-1.5 text-qn-dim">
          手机首次配对核对该指纹；重新生成证书后须从电脑重新复制连接信息。配对只供本人设备使用。
        </p>
      </InfoBlock>

      {manageOpen && (
        <MobileSettingsDialog
          onClose={() => {
            setManageOpen(false)
            void load()
          }}
        />
      )}
    </div>
  )
}
