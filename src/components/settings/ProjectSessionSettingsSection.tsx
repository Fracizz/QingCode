import { useI18n } from '../../lib/i18n'
import { DEFAULT_SESSION_PERSIST, saveSessionPersistEnabled } from '../../lib/sessionPersistSettings'
import {
  DEFAULT_EDITOR_STATE_CACHE_SIZE,
  MAX_EDITOR_STATE_CACHE_SIZE,
  MIN_EDITOR_STATE_CACHE_SIZE,
  saveEditorStateCacheSize,
} from '../../lib/editorStateCacheSettings'
import {
  DEFAULT_PROJECT_INDICATORS_ENABLED,
  saveProjectIndicatorsEnabled,
} from '../../lib/projectIndicatorSettings'
import {
  DEFAULT_GIT_REFRESH_INTERVAL_START_MINUTES,
  MAX_GIT_REFRESH_INTERVAL_START_MINUTES,
  MIN_GIT_REFRESH_INTERVAL_START_MINUTES,
} from '../../lib/gitRefreshSettings'
import { useProjectStore } from '../../store/projectStore'
import { SettingItem } from '../SettingsLayout'
import type { ProjectSessionSettingsState } from './useSettingsSectionState'
import type { SettingsMatch } from './types'

type Props = {
  match: SettingsMatch
  workspaceLocked: boolean
  settings: ProjectSessionSettingsState
}

/** 项目与会话分区：会话状态保存、项目会话 LRU、顶栏项目角标、Git 随机刷新周期。 */
export default function ProjectSessionSettingsSection({ match, workspaceLocked, settings }: Props) {
  const { t } = useI18n()
  const pushToast = useProjectStore(s => s.pushToast)
  const {
    sessionPersist,
    setSessionPersist,
    editorStateCacheSize,
    setEditorStateCacheSize,
    editorStateCacheSizeDraft,
    setEditorStateCacheSizeDraft,
    editorStateCacheSizeLoaded,
    projectIndicatorsEnabled,
    setProjectIndicatorsEnabled,
    gitRefreshIntervalStartMinutes,
    gitRefreshIntervalStartDraft,
    setGitRefreshIntervalStartDraft,
    persistEditorStateCacheSize,
    persistGitRefreshIntervalStartMinutes,
  } = settings

  return (
    <>
      {match('会话状态', '会话状态保存', '会话') && (
        <SettingItem
          title={t('会话状态保存')}
          description={t(
            '重启后恢复编辑器标签、终端与运行配置关联。关闭后不再保存或恢复，并清除已缓存的会话快照。',
          )}
          modified={sessionPersist !== DEFAULT_SESSION_PERSIST}
          locked={workspaceLocked}
          lockHint={t('此设置仅在用户作用域中可用')}
        >
          <select
            value={sessionPersist ? 'on' : 'off'}
            disabled={workspaceLocked}
            onChange={e => {
              const enabled = e.target.value === 'on'
              setSessionPersist(enabled)
              void saveSessionPersistEnabled(enabled).catch(error =>
                pushToast('error', t('保存会话设置失败: {error}', { error: String(error) })),
              )
            }}
            className="setting-control setting-select"
          >
            <option value="on">{t('开启')}</option>
            <option value="off">{t('关闭')}</option>
          </select>
        </SettingItem>
      )}
      {match('项目会话 LRU', '编辑器状态缓存', '会话', 'LRU') && (
        <>
          <SettingItem
            title={t('项目会话 LRU 个数')}
            description={t(
              '控制跨标签和项目会话保留的编辑器状态数量（撤销栈、选区与折叠状态）。超过数量后优先淘汰最久未使用的状态，不会丢失文件内容。',
            )}
            modified={editorStateCacheSize !== 'auto'}
            locked={workspaceLocked}
            lockHint={t('此设置仅在用户作用域中可用')}
          >
            <select
              aria-label={t('项目会话 LRU 个数')}
              value={editorStateCacheSize === 'auto' ? 'auto' : 'custom'}
              disabled={workspaceLocked || !editorStateCacheSizeLoaded}
              onChange={e => {
                if (e.target.value === 'auto') {
                  setEditorStateCacheSize('auto')
                  setEditorStateCacheSizeDraft(String(DEFAULT_EDITOR_STATE_CACHE_SIZE))
                  void saveEditorStateCacheSize('auto').catch(error =>
                    pushToast(
                      'error',
                      t('保存项目会话 LRU 设置失败: {error}', {
                        error: String(error),
                      }),
                    ),
                  )
                  return
                }
                setEditorStateCacheSize(DEFAULT_EDITOR_STATE_CACHE_SIZE)
                setEditorStateCacheSizeDraft(String(DEFAULT_EDITOR_STATE_CACHE_SIZE))
                void saveEditorStateCacheSize(DEFAULT_EDITOR_STATE_CACHE_SIZE).catch(error =>
                  pushToast(
                    'error',
                    t('保存项目会话 LRU 设置失败: {error}', {
                      error: String(error),
                    }),
                  ),
                )
              }}
              className="setting-control setting-select"
            >
              <option value="auto">
                {t('自动（默认 {count} 个）', {
                  count: DEFAULT_EDITOR_STATE_CACHE_SIZE,
                })}
              </option>
              <option value="custom">{t('自定义')}</option>
            </select>
          </SettingItem>
          {editorStateCacheSize !== 'auto' && (
            <SettingItem
              title={t('项目会话 LRU 自定义个数')}
              description={t('可设为 {min}–{max} 个；失去焦点或按 Enter 后保存。', {
                min: MIN_EDITOR_STATE_CACHE_SIZE,
                max: MAX_EDITOR_STATE_CACHE_SIZE,
              })}
              modified
              locked={workspaceLocked}
              lockHint={t('此设置仅在用户作用域中可用')}
            >
              <input
                aria-label={t('项目会话 LRU 自定义个数')}
                type="number"
                min={MIN_EDITOR_STATE_CACHE_SIZE}
                max={MAX_EDITOR_STATE_CACHE_SIZE}
                step={1}
                value={editorStateCacheSizeDraft}
                disabled={workspaceLocked}
                onChange={e => setEditorStateCacheSizeDraft(e.target.value)}
                onBlur={() => void persistEditorStateCacheSize(editorStateCacheSizeDraft)}
                onKeyDown={e => {
                  if (e.key !== 'Enter') return
                  e.currentTarget.blur()
                }}
                className="setting-control w-28 px-2 py-1 text-right"
              />
            </SettingItem>
          )}
        </>
      )}
      {match('项目角标', '顶栏项目角标', '项目指示') && (
        <SettingItem
          title={t('顶栏项目角标')}
          description={t(
            '在顶栏项目名称旁显示运行中终端、未保存文件与 Git 更改角标。终端与未保存状态随编辑实时更新；Git 数量按已配置的随机刷新周期轮询，窗口重新聚焦或 Git 状态变更时也会刷新。关闭后隐藏角标，并停止角标使用的多项目 Git 轮询。',
          )}
          modified={projectIndicatorsEnabled !== DEFAULT_PROJECT_INDICATORS_ENABLED}
          locked={workspaceLocked}
          lockHint={t('此设置仅在用户作用域中可用')}
        >
          <select
            value={projectIndicatorsEnabled ? 'on' : 'off'}
            disabled={workspaceLocked}
            onChange={e => {
              const enabled = e.target.value === 'on'
              setProjectIndicatorsEnabled(enabled)
              void saveProjectIndicatorsEnabled(enabled).catch(error =>
                pushToast('error', t('保存项目角标设置失败: {error}', { error: String(error) })),
              )
            }}
            className="setting-control setting-select"
          >
            <option value="on">{t('开启')}</option>
            <option value="off">{t('关闭')}</option>
          </select>
        </SettingItem>
      )}
      {match('Git 随机刷新周期起始值', 'Git 刷新周期起始值', 'Git', '刷新', '分钟') && (
        <SettingItem
          title={t('Git 随机刷新周期起始值（分钟）')}
          description={t(
            '设置每个项目随机 Git 轮询周期的起始值。最小值和默认值均为 5 分钟；实际周期在起始值至其 1.5 倍（向上取整）之间随机选择整分钟。顶栏多项目刷新按随机顺序逐个执行，不会同时并发刷新全部项目；即时刷新不受影响。',
          )}
          modified={gitRefreshIntervalStartMinutes !== DEFAULT_GIT_REFRESH_INTERVAL_START_MINUTES}
          locked={workspaceLocked}
          lockHint={t('此设置仅在用户作用域中可用')}
        >
          <label
            className="setting-control setting-number-with-unit"
            aria-disabled={workspaceLocked}
          >
            <input
              aria-label={t('Git 随机刷新周期起始值（分钟）')}
              type="number"
              min={MIN_GIT_REFRESH_INTERVAL_START_MINUTES}
              max={MAX_GIT_REFRESH_INTERVAL_START_MINUTES}
              step={1}
              value={gitRefreshIntervalStartDraft}
              disabled={workspaceLocked}
              onChange={e => setGitRefreshIntervalStartDraft(e.target.value)}
              onBlur={() =>
                void persistGitRefreshIntervalStartMinutes(gitRefreshIntervalStartDraft)
              }
              onKeyDown={e => {
                if (e.key !== 'Enter') return
                e.currentTarget.blur()
              }}
              className="setting-number-with-unit-input"
            />
            <span className="shrink-0 text-ui-sm text-fg-muted">{t('分钟')}</span>
          </label>
        </SettingItem>
      )}
    </>
  )
}
