import { isTauri } from './tauri'
import { isWebTest } from './webTestMode'

/** Command/data capability, distinct from native desktop window identity. */
export function hasBackend(): boolean {
  return isTauri() || isWebTest()
}
