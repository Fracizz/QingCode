import type { RefObject } from 'react'
import { useI18n } from '../../lib/i18n'
import {
  DEFAULT_FONT_SETTINGS,
  FONT_SIZE_OPTIONS,
  TERMINAL_FONT_OPTIONS,
  type FontSettings,
} from '../../lib/fontSettings'
import { DEFAULT_GLOBAL_SETTINGS } from '../../lib/projectSettings'
import type { TerminalProfileSettings } from '@/lib/terminal/terminalProfiles'
import {
  availableTerminalShells,
  defaultTerminalShell,
  terminalShellLabelKey,
  type TerminalShellId,
} from '@/lib/terminal/terminalShell'
import { confirmClearSshTerminalPasteUploads } from '../../lib/sshTerminalPaste'
import { isSshProject } from '../../lib/sshWorkspace'
import type { Project } from '../../types'
import FontFamilySelect from '../FontFamilySelect'
import SettingSelect from '../SettingSelect'
import { SettingItem } from '../SettingsLayout'
import TerminalProfilesInline from '../TerminalProfilesInline'
import type { TerminalIntegrationSettingsState } from './useSettingsSectionState'
import type { FontSettingUpdater, SettingsMatch } from './types'

type Props = {
  match: SettingsMatch
  workspaceLocked: boolean
  currentProject: Project | null
  fonts: FontSettings
  onFontChange: FontSettingUpdater
  terminal: TerminalProfileSettings
  onTerminalChange: (next: TerminalProfileSettings) => void
  /** 「终端配置」深链接的滚动目标。 */
  profilesRef: RefObject<HTMLDivElement | null>
  settings: TerminalIntegrationSettingsState
}

/** 终端分区：字体、默认 Shell、终端配置、粘贴 / 接回 / 换行 / 运行状态开关、远程粘贴清理。 */
export default function TerminalSettingsSection({
  match,
  workspaceLocked,
  currentProject,
  fonts,
  onFontChange,
  terminal,
  onTerminalChange,
  profilesRef,
  settings,
}: Props) {
  const { t } = useI18n()
  const {
    sshUploadOnPaste,
    largePasteAsFile,
    persistLocalSessions,
    shiftEnterNewline,
    activityIndicator,
    pasteCleanupBusy,
    setPasteCleanupBusy,
    updateSshUploadOnPaste,
    updatePersistLocalSessions,
    updateLargePasteAsFile,
    updateShiftEnterNewline,
    updateActivityIndicator,
  } = settings

  return (
    <>
      {!workspaceLocked && match('终端字体', 'terminal.integrated.fontFamily') && (
        <SettingItem
          title={t('终端 › 集成: 字体族')}
          description={t(
            '独立设置终端字体族，默认使用系统等宽字体。可选择本机全部已安装字体，修改后立即生效。',
          )}
          modified={fonts.terminalFont !== DEFAULT_FONT_SETTINGS.terminalFont}
          locked={workspaceLocked}
          lockHint={t('此设置仅在用户作用域中可用')}
        >
          <FontFamilySelect
            value={fonts.terminalFont}
            presets={TERMINAL_FONT_OPTIONS}
            kind="terminal"
            disabled={workspaceLocked}
            aria-label={t('终端 › 集成: 字体族')}
            onChange={value => onFontChange('terminalFont', value)}
          />
        </SettingItem>
      )}
      {!workspaceLocked && match('终端字号', 'terminal.integrated.fontSize') && (
        <SettingItem
          title={t('终端 › 集成: 字号')}
          description={t('控制终端的字号（像素）。')}
          modified={fonts.terminalFontSize !== DEFAULT_FONT_SETTINGS.terminalFontSize}
          locked={workspaceLocked}
          lockHint={t('此设置仅在用户作用域中可用')}
        >
          <select
            value={fonts.terminalFontSize}
            disabled={workspaceLocked}
            onChange={e => onFontChange('terminalFontSize', Number(e.target.value))}
            className="setting-control setting-select"
          >
            {/* Ctrl + 滚轮可缩放到预设之外的字号，当前值也要能显示。 */}
            {[...new Set<number>([...FONT_SIZE_OPTIONS, fonts.terminalFontSize])].sort((a, b) => a - b).map(size => (
              <option key={size} value={size}>
                {size}
              </option>
            ))}
          </select>
        </SettingItem>
      )}
      {!workspaceLocked && match('默认 Shell', 'pwsh', 'WSL', 'Zsh') && (
        <SettingItem
          title={t('终端 › 集成: 默认 Shell')}
          description={t(
            '新建「普通终端」时使用的主机 Shell（全局）。Windows 默认自动选择 PowerShell 7、Windows PowerShell 或 CMD；macOS/Linux 默认 Zsh。自定义配置可单独指定 Shell。',
          )}
          modified={terminal.defaultShell !== defaultTerminalShell()}
          locked={workspaceLocked}
          lockHint={t('此设置仅在用户作用域中可用')}
        >
          <SettingSelect
            value={terminal.defaultShell}
            disabled={workspaceLocked}
            className="setting-control-wide"
            aria-label={t('终端 › 集成: 默认 Shell')}
            onChange={next =>
              onTerminalChange({
                ...terminal,
                defaultShell: next as TerminalShellId,
              })
            }
            options={availableTerminalShells().map(id => ({
              value: id,
              label: t(terminalShellLabelKey(id)),
            }))}
          />
        </SettingItem>
      )}
      {!workspaceLocked && match('终端配置', '默认启动配置') && (
        <div ref={profilesRef} className="scroll-mt-4">
          <TerminalProfilesInline settings={terminal} onChange={onTerminalChange} />
        </div>
      )}
      {match('SSH', '粘贴', '上传', 'sshUploadOnPaste') && (
        <SettingItem
          title={t('终端 › 集成: SSH 粘贴上传')}
          description={t(
            '在 SSH 终端粘贴或拖入本机文件时，先上传到项目 .qingcode/terminal-paste/，再粘贴远端路径。默认开启。超过 100MB 的文件或文件夹会被拒绝。',
          )}
          modified={
            sshUploadOnPaste !== DEFAULT_GLOBAL_SETTINGS['terminal.integrated.sshUploadOnPaste']
          }
        >
          <select
            value={sshUploadOnPaste ? 'on' : 'off'}
            onChange={e => void updateSshUploadOnPaste(e.target.value === 'on')}
            className="setting-control setting-select"
            aria-label={t('终端 › 集成: SSH 粘贴上传')}
          >
            <option value="off">{t('关闭')}</option>
            <option value="on">{t('开启')}</option>
          </select>
        </SettingItem>
      )}
      {match('粘贴', '大段', '文件', 'largePasteAsFile') && (
        <SettingItem
          title={t('终端 › 集成: 大段粘贴存为文件')}
          description={t(
            '粘贴超过 32KB 或 500 行的文本时，不再询问，直接存为文件并只粘贴文件路径，避免 Claude Code 等终端程序卡顿。关闭时每次询问。SSH 终端需同时开启粘贴上传。',
          )}
          modified={
            largePasteAsFile !== DEFAULT_GLOBAL_SETTINGS['terminal.integrated.largePasteAsFile']
          }
        >
          <select
            value={largePasteAsFile ? 'on' : 'off'}
            onChange={e => void updateLargePasteAsFile(e.target.value === 'on')}
            className="setting-control setting-select"
            aria-label={t('终端 › 集成: 大段粘贴存为文件')}
          >
            <option value="off">{t('关闭')}</option>
            <option value="on">{t('开启')}</option>
          </select>
        </SettingItem>
      )}
      {match('持久', '接回', '保留', '本地终端', 'persistLocalSessions') && (
        <SettingItem
          title={t('终端 › 集成: 本地终端可接回')}
          description={t(
            '新建的本地终端由后台宿主进程托管，关闭或升级 QingCode 后进程继续运行，下次打开时接回。仅 Windows 的 PowerShell 和 CMD 终端支持；一次性运行任务和 WSL 终端不受影响。电脑重启后终端会按原配置重新启动，连续断开 24 小时后自动结束。',
          )}
          modified={
            persistLocalSessions !== DEFAULT_GLOBAL_SETTINGS['terminal.integrated.persistLocalSessions']
          }
        >
          <select
            value={persistLocalSessions ? 'on' : 'off'}
            onChange={e => void updatePersistLocalSessions(e.target.value === 'on')}
            className="setting-control setting-select"
            aria-label={t('终端 › 集成: 本地终端可接回')}
          >
            <option value="off">{t('关闭')}</option>
            <option value="on">{t('开启')}</option>
          </select>
        </SettingItem>
      )}
      {match('Shift+Enter', '换行', 'Agent', 'shiftEnterNewline') && (
        <SettingItem
          title={t('终端 › 集成: Shift+Enter 换行')}
          description={t(
            '在 Claude Code、Codex、OpenCode 等 Agent 或全屏 TUI 中，Shift+Enter 换行而不提交。普通 Shell 不受影响。Ctrl+Enter 始终换行。',
          )}
          modified={
            shiftEnterNewline !== DEFAULT_GLOBAL_SETTINGS['terminal.integrated.shiftEnterNewline']
          }
        >
          <select
            value={shiftEnterNewline ? 'on' : 'off'}
            onChange={e => void updateShiftEnterNewline(e.target.value === 'on')}
            className="setting-control setting-select"
            aria-label={t('终端 › 集成: Shift+Enter 换行')}
          >
            <option value="on">{t('开启')}</option>
            <option value="off">{t('关闭')}</option>
          </select>
        </SettingItem>
      )}
      {match('状态', '运行中', 'tabActivityIndicator') && (
        <SettingItem
          title={t('终端 › 集成: 标签运行状态')}
          description={t(
            '在终端标签上显示「运行中」呼吸点：程序标题在转圈，或持续输出约 1 秒以上时亮起，停止约 3 秒后熄灭。由输出事件驱动，不轮询进程；不出声的长命令（如静默编译）不会亮。',
          )}
          modified={
            activityIndicator !== DEFAULT_GLOBAL_SETTINGS['terminal.integrated.tabActivityIndicator']
          }
        >
          <select
            value={activityIndicator ? 'on' : 'off'}
            onChange={e => void updateActivityIndicator(e.target.value === 'on')}
            className="setting-control setting-select"
            aria-label={t('终端 › 集成: 标签运行状态')}
          >
            <option value="off">{t('关闭')}</option>
            <option value="on">{t('开启')}</option>
          </select>
        </SettingItem>
      )}
      {match('清理远程粘贴文件', 'terminal-paste') && (
        <SettingItem
          title={t('清理远程粘贴文件')}
          description={t(
            '删除当前 SSH 项目的 .qingcode/terminal-paste 目录。终端里已经粘贴的路径会失效。',
          )}
        >
          <button
            type="button"
            disabled={pasteCleanupBusy || !currentProject || !isSshProject(currentProject)}
            className="setting-control px-2.5 py-1 text-ui-sm border border-border-strong rounded hover:border-accent/60 disabled:opacity-40"
            aria-label={t('清理远程粘贴文件')}
            onClick={() => {
              if (!currentProject || !isSshProject(currentProject)) return
              setPasteCleanupBusy(true)
              void confirmClearSshTerminalPasteUploads(currentProject.path).finally(() =>
                setPasteCleanupBusy(false),
              )
            }}
          >
            {t('清理')}
          </button>
        </SettingItem>
      )}
    </>
  )
}
