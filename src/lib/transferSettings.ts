import type { Project } from '../types'
import { loadGlobalSettings, loadProjectSettings } from './projectSettings'

export const TRANSFER_CONCURRENCY_KEY = 'ssh.transfer.concurrency'
export const DEFAULT_TRANSFER_CONCURRENCY = 4
export const MAX_TRANSFER_CONCURRENCY = 8

export function parseTransferConcurrency(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return DEFAULT_TRANSFER_CONCURRENCY
  return Math.min(MAX_TRANSFER_CONCURRENCY, Math.max(1, Math.floor(value)))
}

export async function loadTransferConcurrency(project?: Project): Promise<number> {
  const global = await loadGlobalSettings()
  const workspace = project ? await loadProjectSettings(project) : undefined
  return parseTransferConcurrency(workspace?.[TRANSFER_CONCURRENCY_KEY] ?? global[TRANSFER_CONCURRENCY_KEY])
}
