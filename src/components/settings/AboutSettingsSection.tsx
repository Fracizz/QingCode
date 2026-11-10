import { openUrl } from '@tauri-apps/plugin-opener'
import { useI18n } from '../../lib/i18n'
import { isTauri } from '../../lib/tauri'
import { DEFAULT_UPDATE_SETTINGS, saveCheckOnStartup } from '../../lib/updateSettings'
import { checkForAppUpdate, promptAppUpdate } from '../../lib/appUpdate'
import { copyToClipboard } from '../../utils/fileReferences'
import { useProjectStore } from '../../store/projectStore'
import { SettingItem } from '../SettingsLayout'
import Tooltip from '../Tooltip'
import type { AboutSettingsState } from './useSettingsSectionState'
import type { SettingsMatch } from './types'

/** Dual-remote git sources shown in 设置 → 关于. Mirrors AGENTS.md. */
const ABOUT_REMOTES: { id: string; label: string; cloneUrl: string; pageUrl: string }[] = [
  {
    id: 'gitee',
    label: 'Gitee',
    cloneUrl: 'https://gitee.com/FrancizTest_admin/qing-code.git',
    pageUrl: 'https://gitee.com/FrancizTest_admin/qing-code',
  },
  {
    id: 'github',
    label: 'GitHub',
    cloneUrl: 'https://github.com/Fracizz/QingCode.git',
    pageUrl: 'https://github.com/Fracizz/QingCode',
  },
]

type Props = {
  match: SettingsMatch
  workspaceLocked: boolean
  settings: AboutSettingsState
}

/** 更新与关于分区：自动检查更新、手动检查、版本、源代码仓库、协议。 */
export default function AboutSettingsSection({ match, workspaceLocked, settings }: Props) {
  const { t } = useI18n()
  const pushToast = useProjectStore(s => s.pushToast)
  const {
    checkOnStartup,
    setCheckOnStartup,
    updateCheckBusy,
    setUpdateCheckBusy,
    appVersion,
    aboutCopyBusy,
    setAboutCopyBusy,
  } = settings

  return (
    <>
      {match('检查更新', '自动检查更新', '更新') && (
        <>
          <SettingItem
            title={t('启动时自动检查更新')}
            description={t(
              '正式构建启动后约 3 秒静默查询 GitHub / Gitee Release。关闭后仍可手动检查。',
            )}
            modified={checkOnStartup !== DEFAULT_UPDATE_SETTINGS.checkOnStartup}
            locked={workspaceLocked}
            lockHint={t('此设置仅在用户作用域中可用')}
          >
            <select
              value={checkOnStartup ? 'on' : 'off'}
              disabled={workspaceLocked}
              onChange={e => {
                const enabled = e.target.value === 'on'
                setCheckOnStartup(enabled)
                void saveCheckOnStartup(enabled).catch(error =>
                  pushToast('error', t('保存更新设置失败: {error}', { error: String(error) })),
                )
              }}
              className="setting-control setting-select"
            >
              <option value="on">{t('开启')}</option>
              <option value="off">{t('关闭')}</option>
            </select>
          </SettingItem>
          <SettingItem
            title={t('检查更新')}
            description={t('查询远端最新安装包；发现新版本时可下载安装包，不会自动安装。')}
            modified={false}
            locked={workspaceLocked}
            lockHint={t('此设置仅在用户作用域中可用')}
          >
            <button
              type="button"
              disabled={updateCheckBusy || !isTauri() || workspaceLocked}
              className="setting-control px-2.5 py-1 text-ui-sm border border-border-strong rounded hover:border-accent/60 disabled:opacity-40"
              onClick={() => {
                if (!isTauri()) {
                  pushToast('error', t('检查更新需要 Tauri 桌面环境'))
                  return
                }
                setUpdateCheckBusy(true)
                void checkForAppUpdate({ ignoreSkip: true, prompt: false })
                  .then(async info => {
                    if (!info) {
                      pushToast('success', t('当前已是最新版本'))
                      return
                    }
                    await promptAppUpdate(info)
                  })
                  .catch(error =>
                    pushToast('error', t('检查更新失败: {error}', { error: String(error) })),
                  )
                  .finally(() => setUpdateCheckBusy(false))
              }}
            >
              {updateCheckBusy ? t('正在检查…') : t('检查更新')}
            </button>
          </SettingItem>
        </>
      )}
      {match('关于', '版本', 'QingCode') && (
        <SettingItem
          title={t('QingCode')}
          description={t(
            '轻量级多项目代码编辑器，Tauri 2 + React 19 + Rust。采用 MIT 开源协议。',
          )}
          modified={false}
        >
          <div className="text-right">
            <span className="text-ui-sm text-fg-muted">
              {appVersion ? `v${appVersion}` : t('版本未知')}
            </span>
          </div>
        </SettingItem>
      )}
      {match('源代码仓库', '仓库', 'Gitee', 'GitHub', 'git') && (
        <SettingItem
          title={t('源代码仓库')}
          description={t(
            'QingCode 在 Gitee 与 GitHub 双端镜像维护。点击打开远端页面，或复制克隆地址。',
          )}
          modified={false}
        >
          <div className="flex flex-col items-stretch gap-2 w-full">
            {ABOUT_REMOTES.map(remote => (
              <div
                key={remote.id}
                className="flex items-center gap-2 rounded border border-border px-2.5 py-1.5"
              >
                <span className="text-ui-sm font-medium text-fg flex-shrink-0 w-14">
                  {remote.label}
                </span>
                <code className="flex-1 min-w-0 truncate font-mono text-ui-sm text-fg-muted">
                  {remote.cloneUrl}
                </code>
                <div className="flex items-center gap-1 flex-shrink-0">
                  <Tooltip label={t('复制克隆地址')} side="top">
                    <button
                      type="button"
                      disabled={aboutCopyBusy === remote.id}
                      onClick={() => {
                        setAboutCopyBusy(remote.id)
                        void copyToClipboard(remote.cloneUrl)
                          .then(() =>
                            pushToast(
                              'success',
                              t('已复制 {label} 克隆地址', { label: remote.label }),
                            ),
                          )
                          .catch(error =>
                            pushToast('error', t('复制失败: {error}', { error: String(error) })),
                          )
                          .finally(() => setAboutCopyBusy(null))
                      }}
                      className="inline-flex h-6 shrink-0 items-center justify-center rounded px-2 text-ui-sm whitespace-nowrap text-fg-muted hover:bg-bg-hover hover:text-fg disabled:opacity-40"
                      aria-label={t('复制克隆地址')}
                    >
                      {aboutCopyBusy === remote.id ? '…' : t('复制')}
                    </button>
                  </Tooltip>
                  <Tooltip label={t('打开 {label} 页面', { label: remote.label })} side="top">
                    <button
                      type="button"
                      onClick={() => {
                        void openUrl(remote.pageUrl).catch(error =>
                          pushToast(
                            'error',
                            t('打开链接失败: {error}', { error: String(error) }),
                          ),
                        )
                      }}
                      className="inline-flex h-6 shrink-0 items-center justify-center rounded px-2 text-ui-sm whitespace-nowrap text-fg-muted hover:bg-bg-hover hover:text-fg"
                    >
                      {t('打开')}
                    </button>
                  </Tooltip>
                </div>
              </div>
            ))}
          </div>
        </SettingItem>
      )}
      {match('协议', 'License', 'MIT', '开源') && (
        <SettingItem
          title={t('协议')}
          description={t('MIT License — 自由使用、修改与分发，需保留版权声明。')}
          modified={false}
        >
          <button
            type="button"
            onClick={() => {
              void openUrl('https://github.com/Fracizz/QingCode/blob/master/LICENSE').catch(
                error => pushToast('error', t('打开链接失败: {error}', { error: String(error) })),
              )
            }}
            className="setting-control px-2.5 py-1 text-ui-sm border border-border-strong rounded hover:border-accent/60"
          >
            {t('查看 LICENSE')}
          </button>
        </SettingItem>
      )}
    </>
  )
}
