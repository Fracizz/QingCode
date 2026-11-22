import { useEffect, useId, useRef, useState, type MouseEvent as ReactMouseEvent } from 'react'
import { Check, ChevronDown, ChevronRight, Copy, Download, Plus, Terminal, Trash2, X } from 'lucide-react'
import { useI18n } from '../lib/i18n'
import { confirmDialog } from '../store/confirmStore'
import { useProjectStore } from '../store/projectStore'
import { useUIStore } from '../store/uiStore'
import { SHELL_PREWARM_CHANGED_EVENT } from '@/lib/terminal/shellPrewarmSettings'
import {
  CONNECTION_DEFAULT_PROFILE_CHANGED_EVENT,
  connectionDefaultProfileId,
  saveConnectionDefaultProfileId,
} from '@/lib/terminal/connectionDefaultProfile'
import {
  DEFAULT_TERMINAL_PROFILE,
  LOCAL_PROFILE_SCOPE,
  TERMINAL_PROFILES_KEY,
  copyProfileToScope,
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
import ContextMenu, { type ContextMenuItem } from './ContextMenu'
import SettingSelect from './SettingSelect'
import ModalOverlay from './ModalOverlay'
import Tooltip from './Tooltip'

export default function TerminalProfilesManager() {
  const open = useUIStore(s => s.terminalProfilesManagerOpen)
  return open ? <ProfilesDialog /> : null
}

/** 配置分类：通用（scope 缺省）、本机、每条 SSH 连接；找不到对应连接（已删除或尚未加载）的配置单独成组。 */
interface ProfileGroup {
  key: string
  scope: string | undefined
  title: string
  detail: string
  /** 远程连接分组：「设为默认」写入该连接自己的默认配置。 */
  connectionId: string | null
}

function useProfileGroups(profiles: TerminalProfile[]): ProfileGroup[] {
  const { t } = useI18n()
  const connections = useProjectStore(s => s.sshConnections)
  const groups: ProfileGroup[] = [
    { key: 'common', scope: undefined, title: t('通用'), detail: t('所有项目和连接可用'), connectionId: null },
    { key: LOCAL_PROFILE_SCOPE, scope: LOCAL_PROFILE_SCOPE, title: t('本机'), detail: t('仅本机项目可用'), connectionId: null },
    ...connections.map(connection => ({
      key: `ssh:${connection.id}`,
      scope: connection.id,
      title: connection.name.trim() || connection.host,
      detail: `${connection.username}@${connection.host}`,
      connectionId: connection.id,
    })),
  ]
  const known = new Set(groups.map(group => group.scope))
  for (const scope of new Set(profiles.map(profile => profile.scope))) {
    if (scope && !known.has(scope)) {
      groups.push({ key: `orphan:${scope}`, scope, title: t('未知连接'), detail: scope, connectionId: scope })
    }
  }
  return groups
}

function ProfilesDialog() {
  const { t } = useI18n()
  const close = useUIStore(s => s.closeTerminalProfilesManager)
  const [settings, setSettings] = useState(loadTerminalProfileSettings)
  // 连接默认配置存在独立键里，变化时只需重新渲染。
  const [, setConnectionDefaultsVersion] = useState(0)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [menu, setMenu] = useState<{ x: number; y: number; items: ContextMenuItem[] } | null>(null)
  const nameRef = useRef<HTMLInputElement>(null)
  const listRef = useRef<HTMLDivElement>(null)
  const titleId = useId()
  const listId = useId()
  const effectiveDefaultId = getEffectiveDefaultProfileId(settings)
  const customProfiles = settings.profiles.filter(p => p.id !== DEFAULT_TERMINAL_PROFILE.id)
  const groups = useProfileGroups(customProfiles)
  const builtin = { ...DEFAULT_TERMINAL_PROFILE, shell: settings.defaultShell }
  const shellOptions = availableTerminalShells().map(id => ({
    value: id,
    label: t(terminalShellLabelKey(id)),
  }))
  const scopeOptions = groups.map(group => ({
    value: group.scope ?? '',
    label: group.connectionId ? `${group.title}（${group.detail}）` : group.title,
  }))
  const groupOf = (scope: string | undefined) => groups.find(group => group.scope === scope) ?? groups[0]
  const profileName = (profile: TerminalProfile) =>
    profile.id === DEFAULT_TERMINAL_PROFILE.id ? t('普通终端') : profile.name.trim() || t('未命名配置')

  useEffect(() => {
    const refresh = () => setSettings(loadTerminalProfileSettings())
    const refreshDefaults = () => setConnectionDefaultsVersion(n => n + 1)
    const onStorage = (event: StorageEvent) => {
      if (!event.key || event.key === TERMINAL_PROFILES_KEY) refresh()
      else refreshDefaults()
    }
    window.addEventListener('storage', onStorage)
    window.addEventListener(SHELL_PREWARM_CHANGED_EVENT, refresh)
    window.addEventListener('qingcode:settings-imported', refresh)
    window.addEventListener(CONNECTION_DEFAULT_PROFILE_CHANGED_EVENT, refreshDefaults)
    return () => {
      window.removeEventListener('storage', onStorage)
      window.removeEventListener(SHELL_PREWARM_CHANGED_EVENT, refresh)
      window.removeEventListener('qingcode:settings-imported', refresh)
      window.removeEventListener(CONNECTION_DEFAULT_PROFILE_CHANGED_EVENT, refreshDefaults)
    }
  }, [])

  useEffect(() => {
    if (!editingId) return
    nameRef.current?.focus()
    nameRef.current?.select()
    // 复制到其他分类后滚到新配置所在位置。
    const row = listRef.current?.querySelector(`[data-profile-id="${CSS.escape(editingId)}"]`)
    row?.scrollIntoView?.({ block: 'nearest' })
  }, [editingId])

  const updateProfile = (id: string, patch: Partial<TerminalProfile>) =>
    saveTerminalProfileSettings({
      ...settings,
      profiles: settings.profiles.map(profile => profile.id === id ? { ...profile, ...patch } : profile),
    })

  const changeScope = (profile: TerminalProfile, scope: string) => {
    const next: TerminalProfile = { ...profile }
    if (scope) next.scope = scope
    else delete next.scope
    saveTerminalProfileSettings({
      ...settings,
      profiles: settings.profiles.map(item => item.id === profile.id ? next : item),
    })
  }

  const insertProfile = (profile: TerminalProfile) => {
    // 以最新存储为准，避免菜单打开期间其他窗口的修改被覆盖。
    const current = loadTerminalProfileSettings()
    saveTerminalProfileSettings({ ...current, profiles: [...current.profiles, profile] })
    setEditingId(profile.id)
  }

  const addProfile = (scope: string | undefined) =>
    insertProfile(copyProfileToScope({ name: t('新终端配置'), command: '', shell: settings.defaultShell }, scope))

  /** 复制到目标分类；目标分类已有同名配置时加「副本」后缀。 */
  const copyProfile = (source: TerminalProfile, scope: string | undefined) => {
    const name = source.name.trim() || t('未命名配置')
    const taken = settings.profiles.some(profile =>
      profile.id !== DEFAULT_TERMINAL_PROFILE.id && profile.scope === scope && profile.name.trim() === name)
    insertProfile(copyProfileToScope(source, scope, taken ? t('{name} 副本', { name }) : name))
  }

  const openMenu = (event: ReactMouseEvent<HTMLButtonElement>, items: ContextMenuItem[]) => {
    event.currentTarget.focus()
    const rect = event.currentTarget.getBoundingClientRect()
    setMenu({ x: rect.left, y: rect.bottom + 4, items })
  }

  const copyMenuItems = (profile: TerminalProfile): ContextMenuItem[] => [
    { label: t('在当前分类复制'), icon: <Copy size={14} />, action: () => copyProfile(profile, profile.scope) },
    ...groups.filter(group => group.scope !== profile.scope).map((group, index) => ({
      label: t('复制到「{name}」', { name: group.title }),
      hint: group.connectionId ? group.detail : undefined,
      separatorBefore: index === 0,
      action: () => copyProfile(profile, group.scope),
    })),
  ]

  const importMenuItems = (target: ProfileGroup): ContextMenuItem[] => {
    const sources = customProfiles.filter(profile => profile.scope !== target.scope)
    if (!sources.length) return [{ label: t('其他分类中没有可导入的配置'), disabled: true, action: () => {} }]
    return sources.map(profile => ({
      label: `${groupOf(profile.scope).title} / ${profileName(profile)}`,
      hint: profile.command.trim() || t('仅启动 Shell'),
      action: () => copyProfile(profile, target.scope),
    }))
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

  const renderRow = (profile: TerminalProfile, group: ProfileGroup, editorId: string) => {
    const isBuiltin = profile.id === DEFAULT_TERMINAL_PROFILE.id
    const expanded = editingId === profile.id
    const name = profileName(profile)
    // 远程连接分组设置该连接自己的默认配置（再点一次恢复跟随全局）；其余分组设置全局默认。
    const connectionDefault = group.connectionId !== null
    const isDefault = connectionDefault
      ? connectionDefaultProfileId(group.connectionId, settings) === profile.id
      : effectiveDefaultId === profile.id
    const toggleDefault = () => {
      if (connectionDefault) saveConnectionDefaultProfileId(group.connectionId!, isDefault ? null : profile.id)
      else saveTerminalProfileSettings({ ...settings, defaultProfileId: isBuiltin ? null : profile.id })
    }
    return (
      <div key={profile.id} data-profile-id={profile.id} className="terminal-profile-row border-b border-border last:border-b-0">
        <div className="terminal-profile-summary">
          <button
            type="button"
            disabled={isBuiltin}
            aria-expanded={isBuiltin ? undefined : expanded}
            aria-controls={isBuiltin ? undefined : editorId}
            aria-label={isBuiltin ? name : t('编辑终端配置「{name}」', { name })}
            className="terminal-profile-toggle"
            onClick={() => setEditingId(expanded ? null : profile.id)}
          >
            {isBuiltin ? <Terminal size={14} className="shrink-0 text-fg-muted" /> : expanded
              ? <ChevronDown size={14} className="shrink-0 text-fg-muted" />
              : <ChevronRight size={14} className="shrink-0 text-fg-muted" />}
            <span className="min-w-0 flex-1 text-left">
              <span className="flex min-w-0 items-center gap-2">
                <span className="truncate font-medium">{name}</span>
                {isBuiltin && <span className="shrink-0 text-ui-xs text-fg-muted">{t('内置')}</span>}
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
              aria-label={connectionDefault
                ? t('将「{name}」设为此连接的默认终端', { name })
                : t('将「{name}」设为默认终端', { name })}
              aria-pressed={isDefault}
              disabled={isDefault && !connectionDefault}
              className={`terminal-profile-default ${isDefault ? 'text-brand' : 'text-fg-muted hover:bg-bg-hover hover:text-fg'}`}
              onClick={toggleDefault}
            >
              {isDefault && <Check size={12} />}
              {connectionDefault
                ? isDefault ? t('此连接默认') : t('设为此连接默认')
                : isDefault ? t('默认') : t('设为默认')}
            </button>
            {!isBuiltin && <>
              <Tooltip label={t('复制配置')} side="top">
                <button
                  type="button"
                  aria-label={t('复制终端配置「{name}」', { name })}
                  aria-haspopup="menu"
                  className="terminal-profile-icon"
                  onClick={event => openMenu(event, copyMenuItems(profile))}
                >
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
        {!isBuiltin && expanded && (
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
              <span>{t('适用范围')}</span>
              <SettingSelect value={profile.scope ?? ''} aria-label={t('适用范围')} menuZIndex={120} className="!min-w-0 !w-full !max-w-none" onChange={next => changeScope(profile, next)} options={scopeOptions} />
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
  }

  return (<>
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
        <div ref={listRef} className="terminal-profiles min-h-0 flex-1 overflow-y-auto px-5 py-4">
          <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
            <p className="text-ui-sm text-fg-muted">{t('按远程连接分类，新建终端时只列出通用配置和项目所属分类的配置。修改自动保存。')}</p>
            <button type="button" onClick={() => addProfile(undefined)} className="terminal-profile-add">
              <Plus size={14} />{t('添加终端配置')}
            </button>
          </div>
          <div className="space-y-3">
            {groups.map(group => {
              const members = customProfiles.filter(profile => profile.scope === group.scope)
              const rows = group.scope === undefined ? [builtin, ...members] : members
              const headingId = `${listId}-${group.key}`
              return (
                <section key={group.key} data-profile-group={group.key} aria-labelledby={headingId}>
                  <div className="terminal-profile-group-header">
                    <div className="min-w-0 flex-1">
                      <h3 id={headingId} className="truncate text-ui font-semibold text-fg">{group.title}</h3>
                      <p className="truncate text-ui-xs text-fg-muted">{group.detail}</p>
                    </div>
                    <Tooltip label={t('从其他分类导入')} side="top">
                      <button
                        type="button"
                        aria-label={t('导入终端配置到「{name}」', { name: group.title })}
                        aria-haspopup="menu"
                        className="terminal-profile-icon"
                        onClick={event => openMenu(event, importMenuItems(group))}
                      >
                        <Download size={14} />
                      </button>
                    </Tooltip>
                    <Tooltip label={t('添加终端配置')} side="top">
                      <button
                        type="button"
                        aria-label={t('在「{name}」中添加终端配置', { name: group.title })}
                        className="terminal-profile-icon"
                        onClick={() => addProfile(group.scope)}
                      >
                        <Plus size={14} />
                      </button>
                    </Tooltip>
                  </div>
                  {rows.length ? (
                    <div className="overflow-hidden rounded-md border border-border">
                      {rows.map((profile, index) => renderRow(profile, group, `${headingId}-${index}`))}
                    </div>
                  ) : (
                    <p className="terminal-profile-empty">{t('暂无配置，可添加或从其他分类导入。')}</p>
                  )}
                </section>
              )
            })}
          </div>
        </div>
      </div>
    </ModalOverlay>
    {menu && <ContextMenu x={menu.x} y={menu.y} zIndex="z-[135]" items={menu.items} onClose={() => setMenu(null)} />}
  </>)
}
