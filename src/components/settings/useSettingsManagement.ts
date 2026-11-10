/**
 * 设置页「管理设置」菜单的动作：打开设置 JSON、导入 / 导出配置、恢复默认。
 */
import { useState } from 'react'
import { open, save } from '@tauri-apps/plugin-dialog'
import { useI18n } from '../../lib/i18n'
import { safeInvoke } from '../../lib/tauri'
import { hasBackend } from '../../lib/runtimeCapabilities'
import {
  ensureSettingsFile,
  resolveGlobalSettingsPath,
  resolveProjectSettingsPath,
} from '../../lib/projectSettings'
import { authorizePaths } from '../../lib/pathAllowlist'
import { exportSettings, importSettings, resetSettings } from '../../lib/settingsTransfer'
import { confirmDialog } from '../../store/confirmStore'
import { useProjectStore } from '../../store/projectStore'
import { useEditorStore } from '../../store/editorStore'
import { useUIStore } from '../../store/uiStore'
import { normalizeProjectPath } from '../../utils/fileTreeHelpers'
import type { Project } from '../../types'
import type { SettingsScope } from './types'

export function useSettingsManagement(scope: SettingsScope, currentProject: Project | null) {
  const { t } = useI18n()
  const pushToast = useProjectStore(s => s.pushToast)
  const openFile = useEditorStore(s => s.openFile)
  const setView = useUIStore(s => s.setView)
  const [openingJson, setOpeningJson] = useState(false)
  const [transferBusy, setTransferBusy] = useState(false)

  const openSettingsJson = async (writeDefaults = false) => {
    if (!hasBackend()) {
      pushToast('error', t('当前环境无法打开设置文件'))
      return
    }
    if (scope === 'workspace' && !currentProject) {
      pushToast('error', t('请先选择项目，再配置项目设置。'))
      return
    }
    setOpeningJson(true)
    try {
      const path =
        scope === 'user'
          ? await resolveGlobalSettingsPath()
          : await resolveProjectSettingsPath(currentProject!)
      // Always prefer the commented JSON5 template for missing / bare default files.
      await ensureSettingsFile(path, {
        scope: scope === 'user' ? 'global' : 'project',
        writeTemplate: writeDefaults,
        upgradeComments: true,
      })
      await openFile(path)
      setView('explorer')
      pushToast(
        'success',
        writeDefaults ? t('已写入默认模板并在编辑器中打开') : t('已在编辑器中打开设置文件'),
      )
    } catch (reason) {
      pushToast('error', t('打开设置失败: {error}', { error: String(reason) }))
    } finally {
      setOpeningJson(false)
    }
  }

  const transferSettings = async (action: 'import' | 'export') => {
    if (!hasBackend()) {
      pushToast('error', t('当前环境无法导入或导出配置'))
      return
    }
    setTransferBusy(true)
    const settingsScope = scope === 'user' ? 'global' : 'project'
    try {
      if (action === 'export') {
        const config = await exportSettings(settingsScope, currentProject)
        const path = await save({
          title: t('导出配置 JSON'),
          defaultPath: settingsScope === 'global'
            ? 'qingcode-user-settings.json'
            : 'qingcode-workspace-settings.json',
          filters: [{ name: 'JSON', extensions: ['json'] }],
        })
        if (!path) return
        const target = settingsScope === 'global'
          ? await resolveGlobalSettingsPath()
          : await resolveProjectSettingsPath(currentProject!)
        if (normalizeProjectPath(path) === normalizeProjectPath(target)) {
          throw new Error(t('导出文件不能覆盖当前设置文件'))
        }
        if (useEditorStore.getState().getAllTabs().some(
          tab => tab.dirty && normalizeProjectPath(tab.path) === normalizeProjectPath(path),
        )) {
          throw new Error(t('请先保存或撤销设置文件中的未保存修改'))
        }
        await authorizePaths([path])
        await safeInvoke('导出配置', 'write_file', {
          path,
          content: `${JSON.stringify(config, null, 2)}\n`,
        })
        pushToast('success', t('配置已导出'))
      } else {
        const path = await open({
          title: t('导入配置 JSON'),
          directory: false,
          multiple: false,
          filters: [{ name: 'JSON / JSON5', extensions: ['json', 'json5'] }],
        })
        if (!path) return
        await authorizePaths([path])
        const result = await importSettings(
          await safeInvoke<string>('读取配置', 'read_file', { path }),
          settingsScope,
          currentProject,
        )
        if (result.skippedProjects.length) {
          pushToast(
            'info',
            t('配置已导入，{count} 个项目路径不可用', { count: result.skippedProjects.length }),
            result.skippedProjects.join('\n'),
          )
        } else {
          pushToast('success', t('配置已导入并生效'))
        }
      }
    } catch (error) {
      pushToast('error', t('配置操作失败: {error}', {
        error: t(error instanceof Error ? error.message : String(error)),
      }))
    } finally {
      setTransferBusy(false)
    }
  }

  const restoreDefaults = async () => {
    if (!hasBackend()) {
      pushToast('error', t('当前环境无法恢复默认设置'))
      return
    }
    setTransferBusy(true)
    const settingsScope = scope === 'user' ? 'global' : 'project'
    try {
      const confirmed = await confirmDialog({
        title: t('恢复默认设置'),
        message: scope === 'user'
          ? t('将用户设置、主题、字体、语言、快捷键和终端配置恢复为默认值，清空自定义设置。保留项目列表、工作区设置和信任授权。')
          : t('将清空项目「{name}」的工作区设置覆盖项和自定义设置，重新继承用户设置。', { name: currentProject?.name ?? '' }),
        kind: 'warning',
        confirmLabel: t('恢复默认设置'),
        cancelLabel: t('取消'),
      })
      if (!confirmed) return
      await resetSettings(settingsScope, currentProject)
      pushToast('success', t('已恢复默认设置并生效'))
    } catch (error) {
      pushToast('error', t('恢复默认设置失败: {error}', {
        error: t(error instanceof Error ? error.message : String(error)),
      }))
    } finally {
      setTransferBusy(false)
    }
  }

  return { openingJson, transferBusy, openSettingsJson, transferSettings, restoreDefaults }
}
