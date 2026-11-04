import { useCallback, useSyncExternalStore } from 'react'
import { getConnectionLatency, subscribeConnectionLatency } from './connectionLatency'

export function useConnectionLatency(rootUri: string | null) {
  const subscribe = useCallback((notify: () => void) =>
    rootUri ? subscribeConnectionLatency(rootUri, notify) : () => {}, [rootUri])
  const snapshot = useCallback(() => getConnectionLatency(rootUri), [rootUri])
  return useSyncExternalStore(subscribe, snapshot)
}
