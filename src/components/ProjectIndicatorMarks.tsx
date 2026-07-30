import { useEffect, useState, type MouseEvent } from 'react'
import Tooltip from './Tooltip'
import { useI18n } from '../lib/i18n'
import {
  isProjectIndicatorsEnabled,
  PROJECT_INDICATORS_EVENT,
} from '../lib/projectIndicatorSettings'
import { navigateToProjectGitChanges } from '../lib/projectIndicatorNavigation'
import type { ProjectIndicators } from '../hooks/useProjectIndicators'
import type { Project } from '../types'

export function useProjectIndicatorsVisible() {
  const [visible, setVisible] = useState(isProjectIndicatorsEnabled)
  useEffect(() => {
    const sync = () => setVisible(isProjectIndicatorsEnabled())
    window.addEventListener(PROJECT_INDICATORS_EVENT, sync)
    return () => window.removeEventListener(PROJECT_INDICATORS_EVENT, sync)
  }, [])
  return visible
}

const GIT_MARK_BUTTON =
  'inline-flex !cursor-pointer items-center justify-center rounded-sm transition-opacity hover:opacity-80 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent/60'

export function ProjectIndicatorMarks({
  project,
  indicators,
}: {
  project: Project
  indicators: ProjectIndicators
}) {
  const { t } = useI18n()
  const visible = useProjectIndicatorsVisible()
  if (
    !visible ||
    (indicators.running === 0 && indicators.dirtyEditors === 0 && indicators.gitChanges === 0)
  ) {
    return null
  }
  const handleGitClick = (event: MouseEvent) => {
    event.stopPropagation()
    event.preventDefault()
    void navigateToProjectGitChanges(project)
  }
  return (
    <span className="ml-1 inline-flex flex-shrink-0 items-center gap-1" aria-hidden>
      {indicators.running > 0 && (
        <Tooltip
          label={t('运行中的终端 {count}', { count: indicators.running })}
          side="bottom"
          wrapperClassName="inline-flex"
        >
          <span className="h-1 w-1 rounded-full bg-accent" />
        </Tooltip>
      )}
      {indicators.dirtyEditors > 0 && (
        <Tooltip
          label={t('未保存文件 {count}', { count: indicators.dirtyEditors })}
          side="bottom"
          wrapperClassName="inline-flex"
        >
          <span className="h-1 w-1 rounded-full bg-warn" />
        </Tooltip>
      )}
      {indicators.gitChanges > 0 && (
        <Tooltip
          label={t('Git 更改 {count} · 点击查看', { count: indicators.gitChanges })}
          side="bottom"
          wrapperClassName="inline-flex"
        >
          <button
            type="button"
            aria-label={t('查看 Git 更改 {count}', { count: indicators.gitChanges })}
            className={GIT_MARK_BUTTON}
            onClick={handleGitClick}
            onPointerDown={event => event.stopPropagation()}
          >
            <span className="inline-flex h-3 min-w-[13px] items-center justify-center rounded-full bg-bg-deep px-0.5 text-[9px] font-medium tabular-nums leading-none text-fg-muted">
              {indicators.gitChanges > 99 ? '99+' : indicators.gitChanges}
            </span>
          </button>
        </Tooltip>
      )}
    </span>
  )
}
