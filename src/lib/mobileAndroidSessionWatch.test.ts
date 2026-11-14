// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createSessionWatch } from '../../mobile/android/web/sessionWatch.js'

afterEach(() => { document.body.replaceChildren(); localStorage.clear(); vi.restoreAllMocks() })

function fixture(rpc: ReturnType<typeof vi.fn>, capabilities = async () => ({ features: ['attention'] })) {
  document.body.innerHTML = '<select id="session-watch"><option value="on">on</option><option value="off">off</option></select><div id="watch-tip" hidden></div><button id="watch-tip-enable"></button><button id="watch-tip-dismiss"></button>'
  const notice = vi.fn()
  const watch = createSessionWatch({ rpc, prefix: 'test:', capabilities, notice, tipBlocked: () => false })
  const change = (value: string) => {
    const select = document.querySelector<HTMLSelectElement>('#session-watch')!
    select.value = value
    select.dispatchEvent(new Event('change'))
  }
  return { watch, change, notice }
}

describe('mobile background alert preferences', () => {
  it('does not misreport a failed network probe as an unsupported desktop version', async () => {
    const { watch, change, notice } = fixture(vi.fn().mockResolvedValue(true), async () => { throw new Error('offline') })
    change('on')
    await Promise.resolve()
    await Promise.resolve()
    await watch.busySeen()
    expect(notice).not.toHaveBeenCalled()
  })
  it('keeps alerts disabled when a permission reply arrives after the user switches them off', async () => {
    let answer!: (value: boolean) => void
    const rpc = vi.fn((op: string, _args?: { enabled: boolean }) => op === 'notification_permission'
      ? new Promise<boolean>(resolve => { answer = resolve }) : Promise.resolve(true))
    const { change } = fixture(rpc)
    change('on')
    change('off')
    answer(true)
    await Promise.resolve()
    await Promise.resolve()
    expect(localStorage.getItem('test:session-watch')).toBe('off')
    expect(rpc.mock.calls.filter(([op]) => op === 'session_watch').every(([, args]) => !args!.enabled)).toBe(true)
  })

  it('keeps an in-memory preference when storage fails and does not ask again', async () => {
    const { watch, change } = fixture(vi.fn().mockResolvedValue(true))
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('quota') })
    change('on')
    await Promise.resolve()
    await Promise.resolve()
    await watch.busySeen()
    expect(document.querySelector<HTMLSelectElement>('#session-watch')!.value).toBe('on')
    expect(document.querySelector<HTMLElement>('#watch-tip')!.hidden).toBe(true)
  })
})
