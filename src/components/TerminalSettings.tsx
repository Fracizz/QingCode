import { Plus, Trash2 } from 'lucide-react'
import {
  DEFAULT_TERMINAL_PROFILE,
  loadTerminalProfileSettings,
  saveTerminalProfileSettings,
  type TerminalProfile,
  type TerminalProfileSettings,
} from '../lib/terminalProfiles'
import {
  availableTerminalShells,
  terminalShellLabelKey,
  type TerminalShellId,
} from '../lib/terminalShell'
import { useState } from 'react'
import { useI18n } from '../lib/i18n'
import SettingSelect from './SettingSelect'

export default function TerminalSettings() {
  const { t } = useI18n()
  const [settings, setSettings] = useState(loadTerminalProfileSettings)
  const shellOptions = availableTerminalShells().map(id => ({
    value: id,
    label: t(terminalShellLabelKey(id)),
  }))

  const save = (next: TerminalProfileSettings) => {
    setSettings(next)
    saveTerminalProfileSettings(next)
  }

  const updateProfile = (id: string, patch: Partial<TerminalProfile>) => {
    save({
      ...settings,
      profiles: settings.profiles.map(profile =>
        profile.id === id ? { ...profile, ...patch } : profile
      ),
    })
  }

  const addProfile = () => {
    save({
      ...settings,
      profiles: [
        ...settings.profiles,
        {
          id: crypto.randomUUID(),
          name: t('新终端配置'),
          command: '',
          shell: settings.defaultShell,
        },
      ],
    })
  }

  const removeProfile = (id: string) => {
    if (id === DEFAULT_TERMINAL_PROFILE.id) return
    const profiles = settings.profiles.filter(profile => profile.id !== id)
    save({
      ...settings,
      profiles,
      defaultProfileId: settings.defaultProfileId === id ? null : settings.defaultProfileId,
    })
  }

  return (
    <div className="flex flex-col gap-4">
      <label className="block">
        <span className="block font-medium text-fg">{t('默认 Shell')}</span>
        <span className="mt-1 block text-xs text-fg-muted">
          {t(
            '新建「普通终端」时使用的主机 Shell（全局）。Windows 默认 PowerShell 7 (pwsh)，可选 cmd / WSL；macOS/Linux 默认 Zsh，可选 Bash / pwsh。自定义配置可单独指定 Shell。',
          )}
        </span>
        <div className="mt-2">
          <SettingSelect
            value={settings.defaultShell}
            className="setting-control-wide !h-9 !rounded !px-2.5"
            aria-label={t('默认 Shell')}
            onChange={next =>
              save({
                ...settings,
                defaultShell: next as TerminalShellId,
              })
            }
            options={shellOptions}
          />
        </div>
      </label>

      <label className="block">
        <span className="block font-medium text-fg">{t('默认启动配置')}</span>
        <span className="mt-1 block text-xs text-fg-muted">
          {t('可不选；未指定时使用内置普通终端。')}
        </span>
        <div className="mt-2">
          <SettingSelect
            value={settings.defaultProfileId ?? ''}
            className="setting-control-wide !h-9 !rounded !px-2.5"
            aria-label={t('默认启动配置')}
            onChange={next =>
              save({
                ...settings,
                defaultProfileId: next ? next : null,
              })
            }
            options={[
              { value: '', label: t('未指定（内置默认）') },
              ...settings.profiles
                .filter(profile => profile.id !== DEFAULT_TERMINAL_PROFILE.id)
                .map(profile => ({
                  value: profile.id,
                  label: profile.name.trim() || t('未命名配置'),
                })),
            ]}
          />
        </div>
      </label>

      <div className="flex items-center justify-between">
        <span className="font-medium text-fg">{t('终端配置')}</span>
        <button
          type="button"
          onClick={addProfile}
          className="inline-flex items-center gap-1 rounded px-2 py-1 text-[12px] text-accent hover:bg-bg-hover"
        >
          <Plus size={13} /> {t('新增配置')}
        </button>
      </div>

      <div className="flex flex-col gap-3">
        {settings.profiles.map(profile => {
          const isBuiltin = profile.id === DEFAULT_TERMINAL_PROFILE.id
          return (
            <div key={profile.id} className="rounded-md border border-border bg-bg/40 p-3">
              <div className="flex items-center gap-2">
                <input
                  value={profile.name}
                  onChange={event => updateProfile(profile.id, { name: event.target.value })}
                  placeholder={t('配置名称')}
                  aria-label={t('配置名称')}
                  disabled={isBuiltin}
                  className="min-w-0 flex-1 rounded border border-border bg-bg-deep px-2 py-1.5 text-[12px] text-fg outline-none focus:border-accent disabled:opacity-70"
                />
                {!isBuiltin && (
                  <button
                    type="button"
                    aria-label={t('删除{value}', { value: profile.name || t('终端配置') })}
                    onClick={() => removeProfile(profile.id)}
                    className="rounded p-1.5 text-fg-dim hover:bg-danger/10 hover:text-danger"
                  >
                    <Trash2 size={14} />
                  </button>
                )}
              </div>
              <label className="mt-2 block">
                <span className="text-[11px] text-fg-muted">{t('Shell')}</span>
                {isBuiltin ? (
                  <p className="text-ui-sm mt-1 text-fg-dim">
                    {t('使用全局默认 Shell')}（{t(terminalShellLabelKey(settings.defaultShell))}）
                  </p>
                ) : (
                  <div className="mt-1">
                    <SettingSelect
                      value={profile.shell}
                      className="setting-control-wide !h-9 !rounded !px-2.5"
                      aria-label={t('{name} Shell', { name: profile.name || t('终端配置') })}
                      onChange={next =>
                        updateProfile(profile.id, { shell: next as TerminalShellId })
                      }
                      options={shellOptions}
                    />
                  </div>
                )}
              </label>
              <label className="mt-2 block">
                <span className="text-[11px] text-fg-muted">{t('启动命令')}</span>
                <textarea
                  value={profile.command}
                  onChange={event => updateProfile(profile.id, { command: event.target.value })}
                  placeholder={
                    isBuiltin
                      ? t('留空：仅启动所选 Shell')
                      : t('例如：opencode')
                  }
                  aria-label={t('{name}启动命令', { name: profile.name || t('终端配置') })}
                  rows={2}
                  spellCheck={false}
                  className="mt-1 w-full min-h-[3rem] resize-y rounded border border-border bg-bg-deep px-2 py-1.5 font-mono text-[12px] text-fg outline-none focus:border-accent wrap-break-word"
                />
              </label>
            </div>
          )
        })}
      </div>
      <p className="text-ui-sm leading-relaxed text-fg-dim">
        {t(
          '点击 + 使用默认配置；右键 + 可选择其它配置。主机 Shell 由全局默认或各配置指定；启动命令留空时只打开所选 Shell。程序（如 opencode）可通过窗口标题自动重命名标签，也可双击标签手动修改。',
        )}
      </p>
    </div>
  )
}
