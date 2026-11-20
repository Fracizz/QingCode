import { useEffect, useId, useRef, useState } from 'react'
import { Check, ChevronDown, ChevronRight, Copy, Plus, Terminal, Trash2, X } from 'lucide-react'
import { useI18n } from '../lib/i18n'
import { confirmDialog } from '../store/confirmStore'
import { useUIStore } from '../store/uiStore'
import { SHELL_PREWARM_CHANGED_EVENT } from '@/lib/terminal/shellPrewarmSettings'
import {
  DEFAULT_TERMINAL_PROFILE,
  TERMINAL_PROFILES_KEY,
  getEffectiveDefaultProfileId,
  loadTerminalProfileSettings,
  saveTerminalProfileSettings,
  type TerminalProfile,
} from '@/lib/terminal/terminalProfiles'
import {
  availableTerminalShells,
  terminalShellLabelKey,
  type TerminalShellId,
} from '@/lib/terminal/terminalShell'
import SettingSelect from './SettingSelect'
import ModalOverlay from './ModalOverlay'
import Tooltip from './Tooltip'

export default function TerminalProfilesManager() {
  const open = useUIStore(s => s.terminalProfilesManagerOpen)
  return open ? <ProfilesDialog /> : null
}

function ProfilesDialog() {
  const { t } = useI18n()
  const close = useUIStore(s => s.closeTerminalProfilesManager)
  const [settings, setSettings] = useState(loadTerminalProfileSettings)
  const [editingId, setEditingId] = useState<string | null>(null)
  const nameRef = useRef<HTMLInputElement>(null)
  const titleId = useId()
  const listId = useId()
  const effectiveDefaultId = getEffectiveDefaultProfileId(settings)
  const customProfiles = settings.profiles.filter(p => p.id !== DEFAULT_TERMINAL_PROFILE.id)
  const profiles = [{ ...DEFAULT_TERMINAL_PROFILE, shell: settings.defaultShell }, ...customProfiles]
  const shellOptions = availableTerminalShells().map(id => ({
    value: id,
    label: t(terminalShellLabelKey(id)),
  }))

  useEffect(() => {
    const refresh = () => setSettings(loadTerminalProfileSettings())
    const onStorage = (event: StorageEvent) => {
      if (!event.key || event.key === TERMINAL_PROFILES_KEY) refresh()
    }
    window.addEventListener('storage', onStorage)
    window.addEventListener(SHELL_PREWARM_CHANGED_EVENT, refresh)
    window.addEventListener('qingcode:settings-imported', refresh)
    return () => {
      window.removeEventListener('storage', onStorage)
      window.removeEventListener(SHELL_PREWARM_CHANGED_EVENT, refresh)
      window.removeEventListener('qingcode:settings-imported', refresh)
    }
  }, [])

  useEffect(() => {
    if (editingId) {
      nameRef.current?.focus()
      nameRef.current?.select()
    }
  }, [editingId])

  const updateProfile = (id: string, patch: Partial<TerminalProfile>) =>
    saveTerminalProfileSettings({
      ...settings,
      profiles: settings.profiles.map(profile => profile.id === id ? { ...profile, ...patch } : profile),
    })

  const addProfile = (source?: TerminalProfile) => {
    const profile: TerminalProfile = {
      id: crypto.randomUUID(),
      name: source ? t('{name} 副本', { name: source.name.trim() || t('未命名配置') }) : t('新终端配置'),
      shell: source?.shell ?? settings.defaultShell,
      command: source?.command ?? '',
    }
    saveTerminalProfileSettings({ ...settings, profiles: [...settings.profiles, profile] })
    setEditingId(profile.id)
  }

  const removeProfile = async (profile: TerminalProfile) => {
    if (!await confirmDialog({
      title: t('删除终端配置'),
      message: t('确定删除终端配置「{name}」？', { name: profile.name.trim() || t('未命名配置') }),
      detail: effectiveDefaultId === profile.id
        ? t('删除后将使用普通终端作为默认配置，已打开的终端不受影响。')
        : t('已打开的终端不受影响。'),
      confirmLabel: t('删除'),
      kind: 'danger',
    })) return
    const current = loadTerminalProfileSettings()
    saveTerminalProfileSettings({
      ...current,
      profiles: current.profiles.filter(item => item.id !== profile.id),
      defaultProfileId: current.defaultProfileId === profile.id ? null : current.defaultProfileId,
    })
    if (editingId === profile.id) setEditingId(null)
  }

  return (
    <ModalOverlay onDismiss={close}>
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        className="modal-panel modal-lg ui-font-scaled modal-content-enter flex max-h-[85vh] flex-col"
      >
        <div className="flex shrink-0 items-center justify-between gap-3 border-b border-border px-5 py-3.5">
          <h2 id={titleId} className="text-ui-lg font-semibold text-fg">{t('管理终端配置')}</h2>
          <Tooltip label={t('关闭')} side="bottom">
            <button type="button" aria-label={t('关闭')} className="terminal-profile-icon" onClick={close}>
              <X size={16} />
            </button>
          </Tooltip>
        </div>
        <div className="terminal-profiles min-h-0 flex-1 overflow-y-auto px-5 py-4">
          <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
            <p className="text-ui-sm text-fg-muted">{t('修改自动保存。')}</p>
            <button type="button" onClick={() => addProfile()} className="terminal-profile-add">
              <Plus size={14} />{t('添加终端配置')}
            </button>
          </div>
          <div className="overflow-hidden rounded-md border border-border">
            {profiles.map((profile, index) => {
              const builtin = profile.id === DEFAULT_TERMINAL_PROFILE.id
              const expanded = editingId === profile.id
              const isDefault = effectiveDefaultId === profile.id
              const name = builtin ? t('普通终端') : profile.name.trim() || t('未命名配置')
              const editorId = `${listId}-${index}`
              return (
                <div key={profile.id} data-profile-id={profile.id} className="terminal-profile-row border-b border-border last:border-b-0">
                  <div className="terminal-profile-summary">
                    <button
                      type="button"
                      disabled={builtin}
                      aria-expanded={builtin ? undefined : expanded}
                      aria-controls={builtin ? undefined : editorId}
                      aria-label={builtin ? name : t('编辑终端配置「{name}」', { name })}
                      className="terminal-profile-toggle"
                      onClick={() => setEditingId(expanded ? null : profile.id)}
                    >
                      {builtin ? <Terminal size={14} className="shrink-0 text-fg-muted" /> : expanded
                        ? <ChevronDown size={14} className="shrink-0 text-fg-muted" />
                        : <ChevronRight size={14} className="shrink-0 text-fg-muted" />}
                      <span className="min-w-0 flex-1 text-left">
                        <span className="flex min-w-0 items-center gap-2">
                          <span className="truncate font-medium">{name}</span>
                          {builtin && <span className="shrink-0 text-ui-xs text-fg-muted">{t('内置')}</span>}
                        </span>
                        <span className="mt-0.5 block truncate text-ui-sm text-fg-muted">
                          {t(terminalShellLabelKey(profile.shell))}
                          <span className="mx-1.5">·</span>
                          <span className={profile.command.trim() ? 'font-mono' : ''}>
                            {profile.command.trim() || t('仅启动 Shell')}
                          </span>
                        </span>
                      </span>
                    </button>
                    <div className="terminal-profile-actions">
                      <button
                        type="button"
                        aria-label={t('将「{name}」设为默认终端', { name })}
                        aria-pressed={isDefault}
                        disabled={isDefault}
                        className={`terminal-profile-default ${isDefault ? 'text-brand' : 'text-fg-muted hover:bg-bg-hover hover:text-fg'}`}
                        onClick={() => saveTerminalProfileSettings({ ...settings, defaultProfileId: builtin ? null : profile.id })}
                      >
                        {isDefault && <Check size={12} />}{isDefault ? t('默认') : t('设为默认')}
                      </button>
                      {!builtin && <>
                        <Tooltip label={t('复制配置')} side="top">
                          <button type="button" aria-label={t('复制终端配置「{name}」', { name })} className="terminal-profile-icon" onClick={() => addProfile(profile)}>
                            <Copy size={14} />
                          </button>
                        </Tooltip>
                        <Tooltip label={t('删除')} side="top">
                          <button type="button" aria-label={t('删除终端配置「{name}」', { name })} className="terminal-profile-icon hover:!text-danger" onClick={() => void removeProfile(profile)}>
                            <Trash2 size={14} />
                          </button>
                        </Tooltip>
                      </>}
                    </div>
                  </div>
                  {!builtin && expanded && (
                    <div id={editorId} className="terminal-profile-editor">
                      <label className="flex min-w-0 flex-col gap-1.5 text-ui-sm text-fg-muted">
                        {t('名称')}
                        <input ref={nameRef} value={profile.name} onChange={e => updateProfile(profile.id, { name: e.target.value })} className="setting-control !min-w-0 !w-full !max-w-none" />
                      </label>
                      <div className="flex min-w-0 flex-col gap-1.5 text-ui-sm text-fg-muted">
                        <span>{t('Shell')}</span>
                        <SettingSelect value={profile.shell} aria-label={t('Shell')} menuZIndex={120} className="!min-w-0 !w-full !max-w-none" onChange={next => updateProfile(profile.id, { shell: next as TerminalShellId })} options={shellOptions} />
                      </div>
                      <div className="terminal-profile-command flex min-w-0 flex-col gap-1.5 text-ui-sm text-fg-muted">
                        <label htmlFor={`${editorId}-command`}>{t('启动命令')}</label>
                        <input
                          id={`${editorId}-command`}
                          aria-describedby={`${editorId}-hint`}
                          value={profile.command}
                          onChange={e => updateProfile(profile.id, { command: e.target.value })}
                          placeholder={t('留空时仅启动 Shell')}
                          className="setting-control !min-w-0 !w-full !max-w-none font-mono"
                          spellCheck={false}
                        />
                        <span id={`${editorId}-hint`} className="leading-relaxed">
                          {t('Shell 就绪后执行，例如 claude、codex 或 npm run dev。')}
                        </span>
                      </div>
                    </div>
                  )}
                </div>
              )
            })}
          </div>
        </div>
      </div>
    </ModalOverlay>
  )
}
