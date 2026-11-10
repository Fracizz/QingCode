import { useI18n } from '../../lib/i18n'
import { isTauri, safeInvoke } from '../../lib/tauri'
import { registerOpenWith, unregisterOpenWith } from '../../lib/openWithSettings'
import { buildQingcodeCliSkillMarkdown } from '../../lib/qingcodeCliSkill'
import { copyToClipboard } from '../../utils/fileReferences'
import { useProjectStore } from '../../store/projectStore'
import { SettingItem } from '../SettingsLayout'
import Tooltip from '../Tooltip'
import type { ToolsIntegrationSettingsState } from './useSettingsSectionState'
import type { SettingsMatch } from './types'

type Props = {
  match: SettingsMatch
  workspaceLocked: boolean
  isWindows: boolean
  settings: ToolsIntegrationSettingsState
}

/** 工具与集成分区：复制 AI CLI skills、Windows「打开方式」注册。 */
export default function ToolsSettingsSection({ match, workspaceLocked, isWindows, settings }: Props) {
  const { t, language } = useI18n()
  const pushToast = useProjectStore(s => s.pushToast)
  const { openWith, setOpenWith, openWithBusy, setOpenWithBusy, cliSkillBusy, setCliSkillBusy } =
    settings

  return (
    <>
      {match('AI CLI skills', 'AI', 'CLI', 'skills', 'Agent', 'qingcode-cli') && (
        <SettingItem
          title={t('AI CLI skills')}
          description={t(
            '复制 QingCode CLI 的 skills 文本到剪贴板。请按你使用的 AI Agent 文档自行安装（例如保存为 skills.md），QingCode 不会自动适配或注册任何 Agent。',
          )}
          modified={false}
          locked={workspaceLocked}
          lockHint={t('此设置仅在用户作用域中可用')}
        >
          <button
            type="button"
            disabled={cliSkillBusy || workspaceLocked}
            className="setting-control px-2.5 py-1 text-ui-sm border border-border-strong rounded hover:border-accent/60 disabled:opacity-40"
            onClick={() => {
              setCliSkillBusy(true)
              void (async () => {
                try {
                  let exe =
                    (isTauri() ? await safeInvoke<string>('获取程序路径', 'cli_exe_path') : '') ||
                    openWith?.exe_path?.trim() ||
                    ''
                  if (!exe.trim()) exe = 'QingCode.exe'
                  await copyToClipboard(buildQingcodeCliSkillMarkdown(exe, language))
                  pushToast('success', t('已复制 CLI skills，请粘贴到你的 AI Agent 中安装。'))
                } catch (error) {
                  pushToast('error', t('复制失败: {error}', { error: String(error) }))
                } finally {
                  setCliSkillBusy(false)
                }
              })()
            }}
          >
            {cliSkillBusy ? t('正在复制…') : t('复制 skills 文本')}
          </button>
        </SettingItem>
      )}
      {isWindows && match('打开方式', 'Open with', 'Windows') && (
        <SettingItem
          title={t('Windows 打开方式')}
          description={t(
            '将 QingCode 添加到资源管理器「打开方式」菜单，不改变默认程序。排除 .bat/.cmd 执行关联；取消注册后保留已经选择的默认程序。无需管理员权限。',
          )}
          modified={Boolean(openWith?.registered)}
        >
          <div className="flex flex-col items-end gap-2 max-w-md">
            {!isTauri() || openWith?.supported === false ? (
              <span className="text-ui-sm text-fg-dim">{t('仅 Windows 桌面版支持此功能。')}</span>
            ) : (
              <>
                <span className="text-ui-sm text-right text-fg-muted">
                  {openWith?.registered ? t('已注册到「打开方式」') : t('尚未注册')}
                  {openWith?.extensions?.length
                    ? ` · ${t('已注册 {count} 种扩展名', { count: openWith.extensions.length })}`
                    : ''}
                </span>
                {openWith?.exe_path ? (
                  <Tooltip
                    label={openWith.exe_path}
                    side="bottom"
                    onlyWhenOverflow
                    wrapperClassName="block max-w-full min-w-0"
                  >
                    <span className="text-ui-sm block max-w-full truncate font-mono text-fg-dim">
                      {t('当前程序：{path}', { path: openWith.exe_path })}
                    </span>
                  </Tooltip>
                ) : null}
                <div className="flex flex-wrap justify-end gap-2">
                  <button
                    type="button"
                    disabled={openWithBusy}
                    className="setting-control px-2.5 py-1 text-ui-sm border border-border-strong rounded hover:border-accent/60 disabled:opacity-40"
                    onClick={() => {
                      setOpenWithBusy(true)
                      void registerOpenWith()
                        .then(status => {
                          setOpenWith(status)
                          pushToast(
                            'success',
                            t('注册成功。可在资源管理器中右键文件 → 打开方式 → QingCode。'),
                          )
                        })
                        .catch(error =>
                          pushToast('error', t('注册失败: {error}', { error: String(error) })),
                        )
                        .finally(() => setOpenWithBusy(false))
                    }}
                  >
                    {t('注册「打开方式」')}
                  </button>
                  <button
                    type="button"
                    disabled={openWithBusy || !openWith?.registered}
                    className="setting-control px-2.5 py-1 text-ui-sm border border-border-strong rounded hover:border-accent/60 disabled:opacity-40"
                    onClick={() => {
                      setOpenWithBusy(true)
                      void unregisterOpenWith()
                        .then(status => {
                          setOpenWith(status)
                          pushToast('success', t('已取消「打开方式」注册。'))
                        })
                        .catch(error =>
                          pushToast(
                            'error',
                            t('取消注册失败: {error}', { error: String(error) }),
                          ),
                        )
                        .finally(() => setOpenWithBusy(false))
                    }}
                  >
                    {t('取消注册')}
                  </button>
                </div>
              </>
            )}
          </div>
        </SettingItem>
      )}
    </>
  )
}
