import { safeInvoke } from './tauri'
import type { Project } from '../types'

export type ProjectCustomSettings = Record<string, unknown>

export interface ProjectSettingsFile {
  version: 1
  custom: ProjectCustomSettings
}

export const PROJECT_SETTINGS_RELATIVE_PATH = '.qingcode/settings.json'

export const DEFAULT_PROJECT_SETTINGS: ProjectSettingsFile = {
  version: 1,
  custom: {},
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function projectConfigDir(project: Project): string {
  const separator = project.path.includes('\\') && !project.path.includes('/') ? '\\' : '/'
  return `${project.path}${separator}.qingcode`
}

export function projectSettingsPath(project: Project): string {
  const separator = project.path.includes('\\') && !project.path.includes('/') ? '\\' : '/'
  return `${projectConfigDir(project)}${separator}settings.json`
}

export function parseProjectSettings(input: unknown): ProjectSettingsFile {
  if (!isRecord(input) || !isRecord(input.custom)) return { ...DEFAULT_PROJECT_SETTINGS }
  return { version: 1, custom: input.custom }
}

export function validateProjectSettings(input: unknown): string | null {
  if (!isRecord(input)) return '项目设置必须是 JSON 对象'
  if (input.version !== 1) return '项目设置版本必须为 1'
  if (!isRecord(input.custom)) return '项目设置必须包含 custom 对象'
  return null
}

export async function loadProjectSettings(project: Project): Promise<ProjectSettingsFile> {
  const raw = await safeInvoke<string>('读取项目设置', 'read_file', {
    path: projectSettingsPath(project),
  })
  return parseProjectSettings(JSON.parse(raw) as unknown)
}

export async function saveProjectSettings(project: Project, settings: ProjectSettingsFile): Promise<void> {
  await safeInvoke('保存项目设置', 'write_file', {
    path: projectSettingsPath(project),
    content: JSON.stringify(settings, null, 2),
  })
}
