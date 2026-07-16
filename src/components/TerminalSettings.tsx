import { Plus, Trash2 } from 'lucide-react'
import {
  DEFAULT_TERMINAL_PROFILE,
  loadTerminalProfileSettings,
  saveTerminalProfileSettings,
  type TerminalProfile,
  type TerminalProfileSettings,
} from '../lib/terminalProfiles'
import { useState } from 'react'

export default function TerminalSettings() {
  const [settings, setSettings] = useState(loadTerminalProfileSettings)

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
        { id: crypto.randomUUID(), name: '新终端配置', command: '' },
      ],
    })
  }

  const removeProfile = (id: string) => {
    if (id === DEFAULT_TERMINAL_PROFILE.id) return
    const profiles = settings.profiles.filter(profile => profile.id !== id)
    save({
      profiles,
      defaultProfileId:
        settings.defaultProfileId === id ? DEFAULT_TERMINAL_PROFILE.id : settings.defaultProfileId,
    })
  }

  return (
    <section className="flex flex-col gap-4 px-4 py-5 text-[13px]">
      <div>
        <h2 className="text-sm font-medium text-fg">终端</h2>
        <p className="mt-1 leading-relaxed text-fg-muted">
          新终端会按默认配置启动。启动命令留空时，就是普通的 PowerShell 终端。
        </p>
      </div>

      <label className="block">
        <span className="block font-medium text-fg">默认启动配置</span>
        <select
          value={settings.defaultProfileId}
          onChange={event => save({ ...settings, defaultProfileId: event.target.value })}
          className="mt-2 w-full rounded border border-border-strong bg-bg-elevated px-2.5 py-2 text-fg outline-none focus:border-accent"
        >
          {settings.profiles.map(profile => (
            <option key={profile.id} value={profile.id}>
              {profile.name.trim() || '未命名配置'}
            </option>
          ))}
        </select>
      </label>

      <div className="flex items-center justify-between">
        <span className="font-medium text-fg">终端配置</span>
        <button
          type="button"
          onClick={addProfile}
          className="inline-flex items-center gap-1 rounded px-2 py-1 text-[12px] text-accent hover:bg-bg-hover"
        >
          <Plus size={13} /> 新增配置
        </button>
      </div>

      <div className="flex flex-col gap-3">
        {settings.profiles.map(profile => (
          <div key={profile.id} className="rounded-md border border-border bg-bg/40 p-3">
            <div className="flex items-center gap-2">
              <input
                value={profile.name}
                onChange={event => updateProfile(profile.id, { name: event.target.value })}
                placeholder="配置名称"
                aria-label="配置名称"
                className="min-w-0 flex-1 rounded border border-border bg-bg-deep px-2 py-1.5 text-[12px] text-fg outline-none focus:border-accent"
              />
              {profile.id !== DEFAULT_TERMINAL_PROFILE.id && (
                <button
                  type="button"
                  aria-label={`删除${profile.name || '终端配置'}`}
                  onClick={() => removeProfile(profile.id)}
                  className="rounded p-1.5 text-fg-dim hover:bg-danger/10 hover:text-danger"
                >
                  <Trash2 size={14} />
                </button>
              )}
            </div>
            <label className="mt-2 block">
              <span className="text-[11px] text-fg-muted">启动命令</span>
              <input
                value={profile.command}
                onChange={event => updateProfile(profile.id, { command: event.target.value })}
                placeholder={profile.id === DEFAULT_TERMINAL_PROFILE.id ? '留空：启动 PowerShell' : '例如：opencode'}
                aria-label={`${profile.name || '终端配置'}启动命令`}
                className="mt-1 w-full rounded border border-border bg-bg-deep px-2 py-1.5 font-mono text-[12px] text-fg outline-none focus:border-accent"
              />
            </label>
          </div>
        ))}
      </div>
      <p className="text-[12px] leading-relaxed text-fg-dim">
        启动命令直接运行在终端中。标签名固定为「终端 N」编号或任务名，
        如需自定义可双击标签重命名。
      </p>
    </section>
  )
}
