import { useState } from 'react'
import { isGlobalAccessMode, readLocalePreference, saveLocalePreference, t, type LocalePreference } from '@qn/codex-client'
import { Select } from '../../components/primitives'
import { Checkbox, Modal } from '../../components/ui'
import { DEFAULT_FONT_SIZES, FONT_SIZES, isFontSize } from '../../../../shared/fontSizes'
import { AUTO_ARCHIVE_DAYS, isAutoArchiveDays } from '../../../../shared/backendApi'
import { useFiles } from '../files/filesStore'
import { ComposerShortcutsSetting } from './ComposerShortcutsSetting'
import { RUNNING_SEND_SETTING_OPTIONS, useRunningSend } from './runningSend'
import { useSettings } from './settingsStore'
import {
  DEFAULT_AGENT_OPTIONS,
  DENSITY_OPTIONS,
  FONT_SIZE_SETTINGS,
  LANGUAGE_TITLE,
  SEND_KEY_OPTIONS,
  THEME_OPTIONS,
  isSettingsAgent,
  isSettingsDensity,
  isSettingsSendKey,
  isSettingsTheme,
} from './settingsModel'
import { SectionHeading, Segmented, SettingRow } from './fields'

const globalAccessOptions = [
  { value: 'default', label: t('请求批准') },
  { value: 'auto', label: t('替我批准') },
  { value: 'fullAccess', label: t('完全访问') },
]

const archiveOptions = AUTO_ARCHIVE_DAYS.map((days) => ({
  value: String(days),
  label: days === 0 ? t('永不') : days === 1 ? t('1 天') : t('{days} 天', { days }),
}))

// 语言名称始终用本语言书写，看不懂当前界面语言也能选回来。
const languageOptions: Array<{ value: LocalePreference; label: string }> = [
  { value: 'system', label: t('跟随系统') },
  { value: 'zh', label: '中文' }, // i18n-ignore: 语言名称用本语言书写
  { value: 'en', label: 'English' },
]

export function GeneralSection({ visible }: { visible: (itemId: string) => boolean }) {
  const general = useSettings((state) => state.settings.general)
  const update = useSettings((state) => state.update)
  const runningSend = useRunningSend((state) => state.preference)
  const setRunningSend = useRunningSend((state) => state.setPreference)
  const fontSizes = FONT_SIZE_SETTINGS.filter(({ id }) => visible(id))
  const [confirmFullAccess, setConfirmFullAccess] = useState(false)
  const [language, setLanguage] = useState(readLocalePreference)
  const [languagePending, setLanguagePending] = useState(false)

  const changeLanguage = (value: string) => {
    const next = languageOptions.find((option) => option.value === value)?.value
    if (!next || next === language) return
    saveLocalePreference(next)
    setLanguage(next)
    // 重载会丢掉编辑器里未保存的内容，这时只提示稍后生效。
    if (useFiles.getState().tabs.some((tab) => tab.dirty)) setLanguagePending(true)
    else window.location.reload()
  }

  return (
    <div>
      {visible('sendKey') && (
        <SettingRow title={t('发送快捷键')} description={t('决定输入框里 Enter 与 Ctrl+Enter 的行为。')}>
          <Select
            aria-label={t('发送快捷键')}
            value={general.sendKey}
            options={[...SEND_KEY_OPTIONS]}
            onValueChange={(value) => {
              if (isSettingsSendKey(value)) void update({ general: { sendKey: value } })
            }}
          />
        </SettingRow>
      )}

      {visible('runningSend') && (
        <SettingRow
          title={t('运行中发送')}
          description={t('会话运行时发送消息的默认处理，仅保存在本机。无法引导时直接发送或排队，不会打断当前一轮。Ctrl+Enter 临时改用另一种方式（发送键为 Ctrl+Enter 时用 Ctrl+Shift+Enter）。')}
        >
          <Segmented
            value={runningSend}
            options={RUNNING_SEND_SETTING_OPTIONS}
            onChange={setRunningSend}
          />
        </SettingRow>
      )}

      {visible('composerShortcuts') && <ComposerShortcutsSetting />}

      {visible('autoConnectLast') && (
        <SettingRow title={t('启动时自动连接上次使用的目标')} description={t('在后台尝试连接，并通过 SSH 检查远端 Server 更新。')}>
          <Checkbox
            checked={general.autoConnectLast}
            onChange={(value) => void update({ general: { autoConnectLast: value } })}
          >
            {t('启动时自动连接')}
          </Checkbox>
        </SettingRow>
      )}

      {visible('defaultAgent') && (
        <SettingRow title={t('新会话默认 Agent')} description={t('草稿态输入框的初始选择；不可用的 Agent 仍会置灰。')}>
          <Select
            aria-label={t('新会话默认 Agent')}
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
          title={t('自动归档不活跃的会话')}
          description={t('本机连接就绪时，定期归档超过所选天数未更新的会话，保留置顶和正在使用的会话。')}
        >
          <Select
            aria-label={t('自动归档不活跃的会话')}
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
          title={t('权限总控')}
          description={t('未单独设置的会话采用此档位，桌面与手机端同步生效。请求批准沿用 Agent 自身配置；替我批准对应 Codex 自动审查、Claude 自动模式；完全访问对应 Codex 关闭沙箱与审批、Claude 跳过审批。')}
        >
          <Select
            aria-label={t('权限总控')}
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
          title={t('界面密度')}
          description={t('紧凑模式缩小界面间距，字体大小可单独调整。')}
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
        <SettingRow title={t('主题')} description={t('深色为默认；灰色整体抬亮一档，浅色为白底。立即生效。')}>
          <Segmented
            value={general.theme}
            options={THEME_OPTIONS}
            onChange={(value) => {
              if (isSettingsTheme(value)) void update({ general: { theme: value } })
            }}
          />
        </SettingRow>
      )}

      {visible('language') && (
        <SettingRow
          title={LANGUAGE_TITLE}
          description={languagePending
            ? <span role="status" className="text-qn-warn">{t('保存文件并重启应用后生效')}</span>
            : t('切换后重新加载界面。')}
        >
          <Select
            aria-label={LANGUAGE_TITLE}
            value={language}
            options={languageOptions}
            onValueChange={changeLanguage}
          />
        </SettingRow>
      )}

      {fontSizes.length > 0 && (
        <section className="mt-6">
          <SectionHeading title={t('字体大小')} />
          {fontSizes.map(({ id, title, description }) => (
            <SettingRow key={id} title={title} description={description}>
              <Select
                aria-label={title}
                value={String(general[id])}
                options={FONT_SIZES.map((size) => ({
                  value: String(size),
                  label: size === DEFAULT_FONT_SIZES[id] ? t('{size} px（默认）', { size }) : `${size} px`,
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
          title={t('将权限总控设为完全访问？')}
          description={t('所有未单独设置访问模式的会话（含手机端发起的）将关闭沙箱与审批：Agent 能直接访问会话所在主机的文件、运行命令并访问网络。')}
          onClose={() => setConfirmFullAccess(false)}
          width="max-w-md"
          footer={(
            <div className="flex justify-end gap-2">
              <button type="button" className="qn-button-subtle" onClick={() => setConfirmFullAccess(false)}>{t('取消')}</button>
              <button
                type="button"
                className="qn-button bg-qn-danger hover:bg-qn-danger"
                onClick={() => {
                  setConfirmFullAccess(false)
                  void update({ general: { globalAccessMode: 'fullAccess' } })
                }}
              >{t('启用')}</button>
            </div>
          )}
        >
          {t('已单独指定访问模式的会话不受影响。')}
        </Modal>
      )}
    </div>
  )
}
