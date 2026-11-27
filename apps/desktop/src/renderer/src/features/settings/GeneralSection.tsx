import { useState } from 'react'
import { isGlobalAccessMode } from '@qn/codex-client'
import { Select } from '../../components/primitives'
import { Checkbox, Modal } from '../../components/ui'
import { DEFAULT_FONT_SIZES, FONT_SIZES, isFontSize } from '../../../../shared/fontSizes'
import { AUTO_ARCHIVE_DAYS, isAutoArchiveDays } from '../../../../shared/backendApi'
import { useSettings } from './settingsStore'
import {
  DEFAULT_AGENT_OPTIONS,
  DENSITY_OPTIONS,
  FONT_SIZE_SETTINGS,
  SEND_KEY_OPTIONS,
  THEME_OPTIONS,
  isSettingsAgent,
  isSettingsDensity,
  isSettingsSendKey,
  isSettingsTheme,
} from './settingsModel'
import { SectionHeading, Segmented, SettingRow } from './fields'

const globalAccessOptions = [
  { value: 'default', label: 'Agent 默认权限' },
  { value: 'restricted', label: '受限权限' },
  { value: 'fullAccess', label: '完全访问' },
]

const archiveOptions = AUTO_ARCHIVE_DAYS.map((days) => ({
  value: String(days),
  label: days === 0 ? '永不' : `${days} 天`,
}))

export function GeneralSection({ visible }: { visible: (itemId: string) => boolean }) {
  const general = useSettings((state) => state.settings.general)
  const update = useSettings((state) => state.update)
  const fontSizes = FONT_SIZE_SETTINGS.filter(({ id }) => visible(id))
  const [confirmFullAccess, setConfirmFullAccess] = useState(false)

  return (
    <div>
      {visible('sendKey') && (
        <SettingRow title="发送快捷键" description="决定输入框里 Enter 与 Ctrl+Enter 的行为。">
          <Select
            aria-label="发送快捷键"
            value={general.sendKey}
            options={[...SEND_KEY_OPTIONS]}
            onValueChange={(value) => {
              if (isSettingsSendKey(value)) void update({ general: { sendKey: value } })
            }}
          />
        </SettingRow>
      )}

      {visible('autoConnectLast') && (
        <SettingRow title="启动时自动连接上次使用的目标" description="在后台尝试连接，并通过 SSH 检查远端 Server 更新。">
          <Checkbox
            checked={general.autoConnectLast}
            onChange={(value) => void update({ general: { autoConnectLast: value } })}
          >
            启动时自动连接
          </Checkbox>
        </SettingRow>
      )}

      {visible('defaultAgent') && (
        <SettingRow title="新会话默认 Agent" description="草稿态输入框的初始选择；不可用的 Agent 仍会置灰。">
          <Select
            aria-label="新会话默认 Agent"
            value={general.defaultAgent}
            options={[...DEFAULT_AGENT_OPTIONS]}
            onValueChange={(value) => {
              if (isSettingsAgent(value)) void update({ general: { defaultAgent: value } })
            }}
          />
        </SettingRow>
      )}

      {visible('autoArchiveDays') && (
        <SettingRow
          title="自动归档不活跃的会话"
          description="本机连接就绪时，定期归档超过所选天数未更新的会话，保留置顶和正在使用的会话。"
        >
          <Select
            aria-label="自动归档不活跃的会话"
            value={String(general.autoArchiveDays)}
            options={archiveOptions}
            onValueChange={(value) => {
              const days = Number(value)
              if (isAutoArchiveDays(days)) void update({ general: { autoArchiveDays: days } })
            }}
          />
        </SettingRow>
      )}

      {visible('globalAccessMode') && (
        <SettingRow
          title="权限总控"
          description="使用「继承总控」的会话采用此设置，桌面与手机端同步生效。受限权限对应 Codex 只读、Claude 计划模式；完全访问对应 Codex 完全访问、Claude 跳过审批。"
        >
          <Select
            aria-label="权限总控"
            value={general.globalAccessMode}
            options={globalAccessOptions}
            onValueChange={(value) => {
              if (!isGlobalAccessMode(value) || value === general.globalAccessMode) return
              // 完全访问会关闭沙箱与审批，切换前需二次确认。
              if (value === 'fullAccess') setConfirmFullAccess(true)
              else void update({ general: { globalAccessMode: value } })
            }}
          />
        </SettingRow>
      )}

      {visible('density') && (
        <SettingRow
          title="界面密度"
          description="紧凑模式缩小界面间距，字体大小可单独调整。"
        >
          <Segmented
            value={general.density}
            options={DENSITY_OPTIONS}
            onChange={(value) => {
              if (isSettingsDensity(value)) void update({ general: { density: value } })
            }}
          />
        </SettingRow>
      )}

      {visible('theme') && (
        <SettingRow title="主题" description="深色为默认；灰色整体抬亮一档，浅色为白底。立即生效。">
          <Segmented
            value={general.theme}
            options={THEME_OPTIONS}
            onChange={(value) => {
              if (isSettingsTheme(value)) void update({ general: { theme: value } })
            }}
          />
        </SettingRow>
      )}

      {fontSizes.length > 0 && (
        <section className="mt-6">
          <SectionHeading title="字体大小" />
          {fontSizes.map(({ id, title, description }) => (
            <SettingRow key={id} title={title} description={description}>
              <Select
                aria-label={title}
                value={String(general[id])}
                options={FONT_SIZES.map((size) => ({
                  value: String(size),
                  label: size === DEFAULT_FONT_SIZES[id] ? `${size} px（默认）` : `${size} px`,
                }))}
                onValueChange={(value) => {
                  const size = Number(value)
                  if (isFontSize(size)) void update({ general: { [id]: size } })
                }}
              />
            </SettingRow>
          ))}
        </section>
      )}
      {confirmFullAccess && (
        <Modal
          title="将权限总控设为完全访问？"
          description="所有「继承总控」的会话（含手机端发起的）将关闭沙箱与审批：Agent 能直接访问会话所在主机的文件、运行命令并访问网络。"
          onClose={() => setConfirmFullAccess(false)}
          width="max-w-md"
          footer={(
            <div className="flex justify-end gap-2">
              <button type="button" className="qn-button-subtle" onClick={() => setConfirmFullAccess(false)}>取消</button>
              <button
                type="button"
                className="qn-button bg-qn-danger hover:bg-qn-danger"
                onClick={() => {
                  setConfirmFullAccess(false)
                  void update({ general: { globalAccessMode: 'fullAccess' } })
                }}
              >启用</button>
            </div>
          )}
        >
          已单独指定访问模式的会话不受影响。
        </Modal>
      )}
    </div>
  )
}
