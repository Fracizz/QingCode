import { Select } from '../../components/primitives'
import { Checkbox } from '../../components/ui'
import { useSettings } from './settingsStore'
import {
  DEFAULT_AGENT_OPTIONS,
  DENSITY_OPTIONS,
  SEND_KEY_OPTIONS,
  THEME_OPTIONS,
  isSettingsAgent,
  isSettingsDensity,
  isSettingsSendKey,
} from './settingsModel'
import { Segmented, SettingRow } from './fields'

export function GeneralSection({ visible }: { visible: (itemId: string) => boolean }) {
  const general = useSettings((state) => state.settings.general)
  const update = useSettings((state) => state.update)

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
        <SettingRow title="启动时自动连接上次使用的目标" description="关闭时启动后仍会回到上次的目标，但需手动点击连接；不会额外保存密码。">
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

      {visible('density') && (
        <SettingRow
          title="界面密度"
          description="紧凑模式会缩小行距与留白，一屏显示更多内容。"
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
        <SettingRow title="主题" description="当前版本只提供深色主题。">
          <Segmented value="dark" options={THEME_OPTIONS} onChange={() => undefined} />
        </SettingRow>
      )}
    </div>
  )
}
