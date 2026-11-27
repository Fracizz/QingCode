import { readLocalePreference, saveLocalePreference, t, type LocalePreference } from '@qn/codex-client'
import { Minus, Plus } from 'lucide-react'
import { useEffect, useState } from 'react'
import { DEFAULT_CHAT_FONT, MAX_CHAT_FONT, MIN_CHAT_FONT, readChatFont, saveChatFont } from '../chatFont'
import { callDevice, getGateway } from '../client'
import { useMobilePreferences, type MobileTheme } from '../mobilePreferences'
import { getWindowNativePort, NativeRequestError, setNativeLocale } from '../native'
import { friendlyError } from '../state'
import { releaseEventStream, useApp } from '../store'
import { Button, Dialog, Field, Note } from './ui'

type UpdateCheck = { available: boolean; versionName: string; versionCode: number; id?: string }
const UPDATE_URL = 'mobile.updateUrl'

const themes: readonly { value: MobileTheme; label: string }[] = [
  { value: 'dark', label: t('深色') },
  { value: 'graphite', label: t('石墨灰') },
  { value: 'light', label: t('浅色') },
  { value: 'system', label: t('跟随系统') },
]

const languages: readonly { value: LocalePreference; label: string }[] = [
  { value: 'system', label: t('跟随系统') },
  // i18n-ignore: 语言名称始终用本语言书写
  { value: 'zh', label: '中文' },
  { value: 'en', label: 'English' },
]

function changeLanguage(preference: LocalePreference) {
  saveLocalePreference(preference)
  setNativeLocale(preference)
  releaseEventStream()
  window.location.reload()
}

function SettingChoice<T extends string | boolean>({
  label, value, options, onChange, hint, disabled,
}: {
  label: string
  value: T
  options: readonly { value: T; label: string }[]
  onChange: (value: T) => void
  hint?: string
  disabled?: boolean
}) {
  return (
    <fieldset className="qn-setting">
      <legend>{label}</legend>
      <div className="qn-segment">
        {options.map((option) => (
          <button type="button" key={String(option.value)} aria-pressed={option.value === value}
            disabled={disabled} onClick={() => { if (option.value !== value) onChange(option.value) }}>
            {option.label}
          </button>
        ))}
      </div>
      {hint && <p className="mt-2 text-xs text-qn-muted">{hint}</p>}
    </fieldset>
  )
}

const toggleOptions = [{ value: false, label: t('关') }, { value: true, label: t('开') }]

export function MobileSettings({ onClose }: { onClose: () => void }) {
  const theme = useMobilePreferences((state) => state.theme)
  const reduceMotion = useMobilePreferences((state) => state.reduceMotion)
  const sendKey = useMobilePreferences((state) => state.sendKey)
  const update = useMobilePreferences((state) => state.update)
  const [chatFont, setChatFont] = useState(readChatFont)
  const [localError, setLocalError] = useState<string | null>(null)
  const [version, setVersion] = useState<string | null>(null)
  const [online, setOnline] = useState(false)
  const [url, setUrl] = useState('')
  const [busy, setBusy] = useState<'check' | 'install' | null>(null)
  const [candidate, setCandidate] = useState<UpdateCheck | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const background = useApp((state) => state.backgroundConnectionEnabled)
  const [savingBackground, setSavingBackground] = useState(false)
  const [backgroundError, setBackgroundError] = useState<string | null>(null)
  const [keepScreenOn, setKeepScreenOn] = useState<boolean | null>(null)
  const [savingScreen, setSavingScreen] = useState(false)
  const [screenError, setScreenError] = useState<string | null>(null)
  const native = Boolean(getWindowNativePort())

  useEffect(() => {
    if (!native) return
    let cancelled = false
    void callDevice<{ versionName: string; online: boolean }>('updates.status').then((result) => {
      if (!cancelled) {
        setVersion(result.versionName)
        setOnline(result.online)
      }
    }).catch((err: unknown) => {
      if (!cancelled) setError(friendlyError(err, t('无法读取应用版本')))
    })
    void getGateway().storageGet(UPDATE_URL).then((value) => {
      if (!cancelled && value) setUrl(value)
    }).catch(() => undefined)
    void callDevice<boolean>('screen.get').then((value) => {
      if (!cancelled) setKeepScreenOn(value)
    }).catch((err: unknown) => {
      if (!cancelled && !(err instanceof NativeRequestError && err.code === 'unsupported')) {
        setScreenError(friendlyError(err, t('无法读取屏幕常亮设置')))
      }
    })
    return () => { cancelled = true }
  }, [native])

  const changeBackground = async (enabled: boolean) => {
    setBackgroundError(null)
    setSavingBackground(true)
    try {
      await callDevice<boolean>('background.set', { enabled })
      useApp.setState({ backgroundConnectionEnabled: enabled })
    } catch (err) {
      setBackgroundError(friendlyError(err, t('无法保存后台连接设置')))
    } finally {
      setSavingBackground(false)
    }
  }

  async function changeScreen(enabled: boolean) {
    setScreenError(null)
    setSavingScreen(true)
    try {
      setKeepScreenOn(await callDevice<boolean>('screen.set', { enabled }))
    } catch (err) {
      setScreenError(friendlyError(err, t('无法保存屏幕常亮设置')))
    } finally {
      setSavingScreen(false)
    }
  }

  function reportLocalSave(ok: boolean) {
    setLocalError(ok ? null : t('无法保存到本机存储，重启后可能恢复到上次保存值。'))
  }

  function changeChatFont(value: number) {
    setChatFont(value)
    reportLocalSave(saveChatFont(value))
  }

  const check = async () => {
    setNotice(null)
    setError(null)
    setCandidate(null)
    let endpoint: URL
    try {
      endpoint = new URL(url.trim())
      if (endpoint.protocol !== 'https:' || endpoint.username || endpoint.password || endpoint.hash) throw new Error()
    } catch {
      setError(t('请输入 HTTPS APK 下载地址。'))
      return
    }
    setBusy('check')
    try {
      await getGateway().storageSet(UPDATE_URL, endpoint.href)
      const result = await callDevice<UpdateCheck>('updates.check', { url: endpoint.href }, 300_000)
      setCandidate(result)
      if (!result.available) setNotice(t('当前已是此地址提供的最新版本。'))
    } catch (err) {
      setError(friendlyError(err, t('检查更新失败')))
    } finally {
      setBusy(null)
    }
  }

  const install = async (id?: string) => {
    setError(null)
    setNotice(null)
    setBusy('install')
    try {
      const result = await callDevice<{ started: boolean }>('updates.install', id ? { id } : {}, 300_000)
      if (result.started) setNotice(t('在 Android 系统界面中确认安装。'))
    } catch (err) {
      setError(friendlyError(err, t('无法安装所选 APK')))
    } finally {
      setBusy(null)
    }
  }

  return (
    <Dialog title={t('应用设置')} onClose={onClose} placement="full">
      <div className="qn-settings">
        <section aria-labelledby="mobile-common-settings">
          <h3 id="mobile-common-settings">{t('常用设置')}</h3>
          {localError && <Note tone="error" message={localError} />}
          {/* i18n-ignore: 语言入口固定双语，看不懂当前语言时也能找到 */}
          <SettingChoice label="语言 / Language" value={readLocalePreference()} options={languages}
            disabled={busy !== null} onChange={changeLanguage} />
          <SettingChoice label={t('主题')} value={theme} options={themes} onChange={(value) => reportLocalSave(update({ theme: value }))} />
          <SettingChoice label={t('界面动效')} value={reduceMotion}
            options={[{ value: false, label: t('跟随系统') }, { value: true, label: t('减少动效') }]}
            onChange={(value) => reportLocalSave(update({ reduceMotion: value }))} />
          <fieldset className="qn-setting">
            <legend>{t('对话字号')}</legend>
            <div className="flex flex-wrap items-center gap-2">
              <Button className="qn-settings-icon" aria-label={t('缩小对话字号')} disabled={chatFont <= MIN_CHAT_FONT}
                onClick={() => changeChatFont(chatFont - 1)}><Minus size={18} aria-hidden /></Button>
              <output className="min-w-12 text-center tabular-nums" aria-label={t('当前对话字号')}>{chatFont} px</output>
              <Button className="qn-settings-icon" aria-label={t('放大对话字号')} disabled={chatFont >= MAX_CHAT_FONT}
                onClick={() => changeChatFont(chatFont + 1)}><Plus size={18} aria-hidden /></Button>
              <Button disabled={chatFont === DEFAULT_CHAT_FONT} onClick={() => changeChatFont(DEFAULT_CHAT_FONT)}>{t('恢复默认')}</Button>
            </div>
            <p className="mt-2 text-xs text-qn-muted">{t('同时调整消息与输入框，也可在对话里双指缩放。')}</p>
          </fieldset>
          <SettingChoice label={t('发送按键')} value={sendKey}
            options={[{ value: 'newline', label: t('回车换行') }, { value: 'send', label: t('回车发送') }]}
            onChange={(value) => reportLocalSave(update({ sendKey: value }))}
            hint={t('Shift+Enter 换行，Ctrl 或 ⌘+Enter 发送。')} />
          {screenError && <Note tone="error" message={screenError} />}
          {keepScreenOn !== null && (
            <SettingChoice label={t('屏幕常亮')} value={keepScreenOn} options={toggleOptions} disabled={savingScreen}
              onChange={(value) => void changeScreen(value)} hint={t('在应用位于前台时保持屏幕点亮。')} />
          )}
          {native && (
            <SettingChoice label={t('后台保持连接')} value={background} options={toggleOptions} disabled={savingBackground}
              onChange={(value) => void changeBackground(value)} hint={t('切到后台或锁屏后保持电脑连接，继续处理已排队消息。')} />
          )}
          {backgroundError && <Note tone="error" message={backgroundError} />}
        </section>
        <section aria-labelledby="mobile-about">
          <h3 id="mobile-about">{t('关于与更新')}</h3>
          <p className="mb-2 text-sm">QingCode Next{version ? ` · ${version}` : ''}</p>
          <p className="mb-4 text-xs text-qn-muted">{t('QingCode Next 是第三方客户端，与 OpenAI、Anthropic 无隶属关系。Agent 用量计入你自己的账号。')}</p>
          {error && <Note tone="error" message={error} />}
          {notice && <Note message={notice} />}
          {online && (
            <>
              <Field label={t('更新地址')} hint={t('填写你信任的 HTTPS APK 下载地址。')}>
                <input className="qn-input" type="url" value={url} disabled={busy !== null}
                  onChange={(event) => { setUrl(event.target.value); setCandidate(null) }}
                  autoCapitalize="off" spellCheck={false} placeholder="https://…" />
              </Field>
              {candidate?.available && candidate.id ? (
                <Button className="mb-2 w-full" variant="primary" disabled={busy !== null} onClick={() => void install(candidate.id)}>
                  {busy === 'install' ? t('正在检查安装包…') : t('安装 {version}', { version: candidate.versionName })}
                </Button>
              ) : (
                <Button className="mb-2 w-full" variant="primary" disabled={busy !== null || !url.trim()} onClick={() => void check()}>
                  {busy === 'check' ? t('正在下载并验证更新…') : t('检查更新')}
                </Button>
              )}
            </>
          )}
          {native && (
            <Button className="w-full" disabled={busy !== null} onClick={() => void install()}>
              {t('从本地 APK 更新')}
            </Button>
          )}
        </section>
      </div>
    </Dialog>
  )
}
