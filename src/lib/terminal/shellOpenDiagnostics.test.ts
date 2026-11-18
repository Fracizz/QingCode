import { expect, it } from 'vitest'
import { recordShellOpen, recentShellOpens } from './shellOpenDiagnostics'

it('summarizes completed opens by project and outcome across the last 100 window samples', () => {
  recordShellOpen('old', 'miss', 999, 'empty')
  for (let i = 1; i <= 98; i++) recordShellOpen('project', 'hit', i)
  recordShellOpen('project', 'miss', 200, 'claim_fallback')
  recordShellOpen('other', 'miss', 300, 'preparing')
  expect(recentShellOpens('project')).toEqual({
    hit: { count: 98, p50Ms: 49, p95Ms: 94 },
    miss: { count: 1, p50Ms: 200, p95Ms: 200 },
    missReasons: { claim_fallback: 1 },
  })
  expect(recentShellOpens('old').miss).toEqual({ count: 0, p50Ms: null, p95Ms: null })
})
