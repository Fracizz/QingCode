import { useMemo } from 'react'
import { useProjectStore } from '../store/projectStore'
import { useI18n } from '../lib/i18n'
import { buildProjectLabels } from '../lib/projectLabels'

export function useProjectLabels() {
  const projects = useProjectStore(s => s.projects)
  const connections = useProjectStore(s => s.sshConnections)
  const { t } = useI18n()
  const localLabel = t('本机')
  return useMemo(
    () => buildProjectLabels(projects, connections, localLabel),
    [projects, connections, localLabel]
  )
}
