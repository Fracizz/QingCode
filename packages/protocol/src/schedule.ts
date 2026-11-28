import type { AgentKind } from './messages'

export type ScheduleFrequency = 'daily' | 'weekdays' | 'weekly'

export type ScheduleCadence = {
  frequency: ScheduleFrequency
  time: string
  timeZone: string
  weekday?: number
}

export type ScheduleRunStatus =
  | 'running' | 'waiting' | 'succeeded' | 'failed' | 'interrupted' | 'skipped' | 'missed' | 'rateLimited'

export type ScheduleRunReason =
  | 'agentUnavailable' | 'profileChanged' | 'projectUnavailable' | 'startFailed' | 'permissionsUnavailable'
  | 'timeout' | 'agentExited' | 'daemonRestarted' | 'turnFailed' | 'busy'

export type ScheduleRun = {
  id: string
  agent: AgentKind
  scheduledAt: number | null
  startedAt: number | null
  finishedAt: number | null
  status: ScheduleRunStatus
  threadId?: string
  reason?: ScheduleRunReason
}

export type ScheduleInput = {
  id?: string
  cwd: string
  name: string
  agent: AgentKind
  prompt: string
  cadence: ScheduleCadence
  enabled: boolean
  piAcknowledged?: boolean
}

export type ScheduleSummary = Omit<ScheduleInput, 'id' | 'piAcknowledged'> & {
  id: string
  nextRunAt: number | null
  rateLimitedUntil: number | null
  requiresManualResume: boolean
  activeRun?: ScheduleRun
  lastRun?: ScheduleRun
}

export type ScheduleRuntime = {
  codexPath?: string
  codexHome?: string
  claudePath?: string
  claudeConfigDir?: string
  piPath?: string
}

export interface ScheduleMethods {
  'schedule.list': { params: { cwd: string }; result: ScheduleSummary[] }
  'schedule.preview': { params: { cadence: ScheduleCadence }; result: number[] }
  'schedule.upsert': { params: ScheduleInput & { runtime?: ScheduleRuntime }; result: ScheduleSummary }
  'schedule.setEnabled': { params: { id: string; cwd: string; enabled: boolean }; result: ScheduleSummary }
  'schedule.runNow': { params: { id: string; cwd: string }; result: { runId: string } }
  'schedule.runs': { params: { id: string; cwd: string }; result: ScheduleRun[] }
  'schedule.delete': { params: { id: string; cwd: string }; result: Record<string, never> }
  'schedule.pauseProject': { params: { cwd: string }; result: { paused: number } }
}

export type ScheduleChangedEvent = { cwd: string }
