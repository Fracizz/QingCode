import { useEffect, useState } from 'react'
import { FileJson, RefreshCw, Save } from 'lucide-react'
import { useProjectStore } from '../store/projectStore'
import {
  DEFAULT_PROJECT_SETTINGS,
  loadProjectSettings,
  parseProjectSettings,
  PROJECT_SETTINGS_RELATIVE_PATH,
  saveProjectSettings,
  validateProjectSettings,
} from '../lib/projectSettings'
import { useI18n } from '../lib/i18n'

function formatSettings(settings = DEFAULT_PROJECT_SETTINGS) {
  return JSON.stringify(settings, null, 2)
}

export default function ProjectCustomSettings() {
  const { t } = useI18n()
  const currentProject = useProjectStore(s => s.currentProject)
  const pushToast = useProjectStore(s => s.pushToast)
  const [draft, setDraft] = useState(formatSettings())
  const [loading, setLoading] = useState(false)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const reload = async () => {
    if (!currentProject) {
      setDraft(formatSettings())
      setError(null)
      return
    }
    setLoading(true)
    setError(null)
    try {
      setDraft(formatSettings(await loadProjectSettings(currentProject)))
    } catch {
      setDraft(formatSettings())
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    void reload()
  }, [currentProject?.id])

  const save = async () => {
    if (!currentProject) return
    let parsed: unknown
    try {
      parsed = JSON.parse(draft) as unknown
    } catch {
      setError(t('JSON 格式无效'))
      return
    }
    const validationError = validateProjectSettings(parsed)
    if (validationError) {
      setError(t(validationError))
      return
    }
    setSaving(true)
    setError(null)
    try {
      const settings = parseProjectSettings(parsed)
      await saveProjectSettings(currentProject, settings)
      setDraft(formatSettings(settings))
      pushToast('success', t('项目自定义设置已保存'))
    } catch (reason) {
      const message = t('保存项目设置失败: {error}', { error: String(reason) })
      setError(message)
      pushToast('error', message)
    } finally {
      setSaving(false)
    }
  }

  if (!currentProject) {
    return <p className="text-xs text-fg-muted">{t('请先选择项目，再配置项目自定义设置。')}</p>
  }

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-start gap-2 text-xs text-fg-muted">
        <FileJson size={14} className="mt-0.5 flex-shrink-0 text-accent" />
        <span>
          {t('当前项目「{name}」的配置文件：', { name: currentProject.name })}
          <code className="ml-1 font-mono text-fg">{PROJECT_SETTINGS_RELATIVE_PATH}</code>
        </span>
      </div>
      <textarea
        value={draft}
        onChange={event => {
          setDraft(event.target.value)
          if (error) setError(null)
        }}
        spellCheck={false}
        className={`min-h-44 w-full resize-y rounded border bg-bg-deep px-2.5 py-2 font-mono text-[12px] leading-5 text-fg outline-none ${
          error ? 'border-danger' : 'border-border-strong focus:border-accent'
        }`}
        aria-label={t('项目自定义设置 JSON')}
      />
      {error && <p className="text-xs text-danger">{error}</p>}
      <div className="flex items-center justify-between gap-2">
        <button
          type="button"
          onClick={() => void reload()}
          disabled={loading || saving}
          className="inline-flex items-center gap-1 rounded px-2 py-1 text-[12px] text-fg-muted hover:bg-bg-hover hover:text-fg disabled:opacity-50"
        >
          <RefreshCw size={13} className={loading ? 'animate-spin' : undefined} /> {t('重新加载')}
        </button>
        <button
          type="button"
          onClick={() => void save()}
          disabled={loading || saving}
          className="inline-flex items-center gap-1 rounded bg-accent px-2.5 py-1.5 text-[12px] text-white hover:bg-accent/90 disabled:opacity-50"
        >
          <Save size={13} /> {t('保存')}
        </button>
      </div>
    </div>
  )
}
