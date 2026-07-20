import { useI18n } from '../lib/i18n'
import {
  DEFAULT_TERMINAL_PROFILE,
  type TerminalProfileSettings,
} from '../lib/terminalProfiles'
import {
  availableTerminalShells,
  terminalShellLabelKey,
  type TerminalShellId,
} from '../lib/terminalShell'
import SettingSelect from './SettingSelect'

export default function TerminalProfilesInline({
  settings,
  onChange,
}: {
  settings: TerminalProfileSettings
  onChange: (next: TerminalProfileSettings) => void
}) {
  const { t } = useI18n()
  const customProfiles = settings.profiles.filter(p => p.id !== DEFAULT_TERMINAL_PROFILE.id)
  const shellOptions = availableTerminalShells().map(id => ({
    value: id,
    label: t(terminalShellLabelKey(id)),
  }))

  return (
    <div className="flex flex-col gap-2">
      {customProfiles.map(profile => (
        <div key={profile.id} className="flex flex-col gap-1.5 rounded border border-border p-2">
          <div className="grid grid-cols-[1fr_auto] gap-2">
            <input
              value={profile.name}
              onChange={e =>
                onChange({
                  ...settings,
                  profiles: settings.profiles.map(item =>
                    item.id === profile.id ? { ...item, name: e.target.value } : item,
                  ),
                })
              }
              placeholder={t('名称')}
              className="setting-control setting-control-wide !w-full"
            />
            <button
              type="button"
              onClick={() => {
                const profiles = settings.profiles.filter(item => item.id !== profile.id)
                onChange({
                  ...settings,
                  profiles,
                  defaultProfileId:
                    settings.defaultProfileId === profile.id ? null : settings.defaultProfileId,
                })
              }}
              className="h-[26px] px-2 rounded-sm text-[12px] text-danger hover:bg-bg-hover"
            >
              {t('删除')}
            </button>
          </div>
          <SettingSelect
            value={profile.shell}
            className="setting-control setting-control-wide !w-full !h-[26px]"
            aria-label={t('Shell')}
            onChange={next =>
              onChange({
                ...settings,
                profiles: settings.profiles.map(item =>
                  item.id === profile.id
                    ? { ...item, shell: next as TerminalShellId }
                    : item,
                ),
              })
            }
            options={shellOptions}
          />
          <input
            value={profile.command}
            onChange={e =>
              onChange({
                ...settings,
                profiles: settings.profiles.map(item =>
                  item.id === profile.id ? { ...item, command: e.target.value } : item,
                ),
              })
            }
            placeholder={t('启动命令')}
            className="setting-control setting-control-wide !w-full font-mono"
          />
        </div>
      ))}
      <button
        type="button"
        onClick={() =>
          onChange({
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
        className="self-start rounded border border-border-strong px-2 py-1 text-[12px] text-fg-muted hover:bg-bg-hover hover:text-fg"
      >
        {t('添加终端配置')}
      </button>
    </div>
  )
}
