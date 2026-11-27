import { Select } from '../../components/primitives'
import { Checkbox } from '../../components/ui'
import { DEFAULT_FONT_SIZES, FONT_SIZES, isFontSize } from '../../../../shared/fontSizes'
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

export function GeneralSection({ visible }: { visible: (itemId: string) => boolean }) {
  const general = useSettings((state) => state.settings.general)
  const update = useSettings((state) => state.update)
  const fontSizes = FONT_SIZE_SETTINGS.filter(({ id }) => visible(id))

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

      {visible('density') && (
        <SettingRow
          title="界面密度"
          description="写入 html[data-density]，只提供样式钩子；具体紧凑规则由界面 token 决定。"
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
    </div>
  )
}
