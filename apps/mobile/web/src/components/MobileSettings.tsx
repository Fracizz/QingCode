import { readLocalePreference, saveLocalePreference, t, type LocalePreference } from '@qn/codex-client'
import {
  ALargeSmall, Check, ChevronRight, CornerDownLeft, CornerDownRight, Download, Info, Languages, Minus, Palette, Plus, Sparkles,
  Sun, Wifi, type LucideIcon,
} from 'lucide-react'
import { useEffect, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { DEFAULT_CHAT_FONT, MAX_CHAT_FONT, MIN_CHAT_FONT, readChatFont, saveChatFont } from '../chatFont'
import { callDevice, getGateway } from '../client'
import { useMobilePreferences, type MobileTheme } from '../mobilePreferences'
import { getWindowNativePort, NativeRequestError, setNativeLocale } from '../native'
import { friendlyError } from '../state'
import { releaseEventStream, useApp } from '../store'
import { Button, Dialog, Field, Note } from './ui'
import { toast } from '../toast'

type UpdateCheck = { available: boolean; versionName: string; versionCode: number; id?: string }
const UPDATE_URL = 'mobile.updateUrl'

// 与电脑版主题一致：深色（默认）、灰色、浅色。
const themes: readonly { value: MobileTheme; label: string }[] = [
  { value: 'dark', label: t('深色') },
  { value: 'gray', label: t('灰色') },
  { value: 'light', label: t('浅色') },
]

const runningSendOptions = [
  { value: 'queue', label: t('排队') },
  { value: 'steer', label: t('引导') },
  { value: 'interrupt', label: t('打断后发送') },
] as const

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

/** 设置分组：小标题 + 一个圆角容器，同组各行共用背景，不逐行描边。 */
function SettingGroup({ title, footnote, children }: { title: string; footnote?: string; children: ReactNode }) {
  return (
    <section className="qn-settings-section" aria-label={title}>
      <h3 className="qn-settings-group-title">{title}</h3>
      <div className="qn-settings-group">{children}</div>
      {footnote && <p className="qn-settings-footnote">{footnote}</p>}
    </section>
  )
}

function RowText({ title, hint }: { title: string; hint?: ReactNode }) {
  return (
    <span className="qn-setting-text">
      <span className="qn-setting-title">{title}</span>
      {hint && <span className="qn-setting-hint">{hint}</span>}
    </span>
  )
}

function RowIcon({ icon: Icon }: { icon: LucideIcon }) {
  return <Icon className="qn-setting-icon" size={22} strokeWidth={1.75} aria-hidden />
}

/** 选项行：右侧显示当前值，点开后在底部弹层里选择；选项说明放进弹层，行内只留标题。 */
function ChoiceRow<T extends string | boolean>({
  icon, title, value, options, onChange, hint, disabled,
}: {
  icon: LucideIcon
  title: string
  value: T
  options: readonly { value: T; label: string }[]
  onChange: (value: T) => void
  hint?: string
  disabled?: boolean
}) {
  const [open, setOpen] = useState(false)
  const current = options.find((option) => option.value === value)
  return (
    <>
      <button type="button" className="qn-setting-row qn-setting-link" disabled={disabled} aria-haspopup="dialog"
        onClick={() => setOpen(true)}>
        <RowIcon icon={icon} />
        <RowText title={title} />
        <span className="qn-setting-value">{current?.label}</span>
        <ChevronRight className="qn-setting-chevron" size={18} aria-hidden />
      </button>
      {/* 挂到 body：嵌在全屏设置页里会被 .qn-dialog[data-placement="full"] 的后代选择器撑成全屏。 */}
      {open && createPortal(
        <Dialog title={title} onClose={() => setOpen(false)}>
          {hint && <p className="qn-select-hint">{hint}</p>}
          <div role="radiogroup" aria-label={title}>
            {options.map((option) => (
              <button type="button" role="radio" key={String(option.value)} className="qn-select-option"
                aria-checked={option.value === value}
                onClick={() => {
                  setOpen(false)
                  if (option.value !== value) onChange(option.value)
                }}>
                <span>{option.label}</span>
                <Check size={18} aria-hidden />
              </button>
            ))}
          </div>
        </Dialog>,
        document.body,
      )}
    </>
  )
}

/** 开关行：整行可点，轨道用全圆端点表达可滑动。 */
function SwitchRow({ icon, title, hint, checked, onChange, disabled }: {
  icon: LucideIcon
  title: string
  hint?: string
  checked: boolean
  onChange: (value: boolean) => void
  disabled?: boolean
}) {
  return (
    <button type="button" role="switch" aria-checked={checked} aria-label={title} disabled={disabled}
      className="qn-setting-row qn-setting-link" onClick={() => onChange(!checked)}>
      <RowIcon icon={icon} />
      <RowText title={title} hint={hint} />
      <span className="qn-switch" aria-hidden />
    </button>
  )
}

export function MobileSettings({ onClose }: { onClose: () => void }) {
  const theme = useMobilePreferences((state) => state.theme)
  const reduceMotion = useMobilePreferences((state) => state.reduceMotion)
  const sendKey = useMobilePreferences((state) => state.sendKey)
  const runningSend = useMobilePreferences((state) => state.runningSend)
  const update = useMobilePreferences((state) => state.update)
  const [chatFont, setChatFont] = useState(readChatFont)
  const [localError, setLocalError] = useState<string | null>(null)
  const [version, setVersion] = useState<string | null>(null)
  const [online, setOnline] = useState(false)
  const [url, setUrl] = useState('')
  const [busy, setBusy] = useState<'check' | 'install' | null>(null)
  const [candidate, setCandidate] = useState<UpdateCheck | null>(null)
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
      if (!result.available) toast(t('当前已是此地址提供的最新版本。'), { tone: 'ok' })
    } catch (err) {
      setError(friendlyError(err, t('检查更新失败')))
    } finally {
      setBusy(null)
    }
  }

  const install = async (id?: string) => {
    setError(null)
    setBusy('install')
    try {
      const result = await callDevice<{ started: boolean }>('updates.install', id ? { id } : {}, 300_000)
      if (result.started) toast(t('在 Android 系统界面中确认安装。'))
    } catch (err) {
      setError(friendlyError(err, t('无法安装所选 APK')))
    } finally {
      setBusy(null)
    }
  }

  return (
    <Dialog title={t('应用设置')} onClose={onClose} placement="full">
      <div className="qn-settings">
        {localError && <Note tone="error" message={localError} />}
        <SettingGroup title={t('外观')}>
          {/* i18n-ignore: 语言入口固定双语，看不懂当前语言时也能找到 */}
          <ChoiceRow icon={Languages} title="语言 / Language" value={readLocalePreference()} options={languages}
            disabled={busy !== null} onChange={changeLanguage} />
          <ChoiceRow icon={Palette} title={t('主题')} value={theme} options={themes}
            onChange={(value) => reportLocalSave(update({ theme: value }))} />
          <ChoiceRow icon={Sparkles} title={t('界面动效')} value={reduceMotion}
            options={[{ value: false, label: t('跟随系统') }, { value: true, label: t('减少动效') }]}
            onChange={(value) => reportLocalSave(update({ reduceMotion: value }))} />
        </SettingGroup>

        <SettingGroup title={t('对话')}>
          <div className="qn-setting-row">
            <RowIcon icon={ALargeSmall} />
            <RowText title={t('对话字号')} hint={(
              <>
                {t('同时调整消息与输入框，也可在对话里双指缩放。')}
                {chatFont !== DEFAULT_CHAT_FONT && (
                  <button type="button" className="qn-setting-inline" onClick={() => changeChatFont(DEFAULT_CHAT_FONT)}>
                    {t('恢复默认')}
                  </button>
                )}
              </>
            )} />
            <div className="qn-stepper">
              <button type="button" aria-label={t('缩小对话字号')} disabled={chatFont <= MIN_CHAT_FONT}
                onClick={() => changeChatFont(chatFont - 1)}><Minus size={16} aria-hidden /></button>
              <output aria-label={t('当前对话字号')}>{chatFont} px</output>
              <button type="button" aria-label={t('放大对话字号')} disabled={chatFont >= MAX_CHAT_FONT}
                onClick={() => changeChatFont(chatFont + 1)}><Plus size={16} aria-hidden /></button>
            </div>
          </div>
          <ChoiceRow icon={CornerDownLeft} title={t('发送按键')} value={sendKey}
            options={[{ value: 'newline', label: t('回车换行') }, { value: 'send', label: t('回车发送') }]}
            onChange={(value) => reportLocalSave(update({ sendKey: value }))}
            hint={t('Shift+Enter 换行，Ctrl 或 ⌘+Enter 发送。')} />
          <ChoiceRow icon={CornerDownRight} title={t('运行中发送')} value={runningSend} options={runningSendOptions}
            onChange={(value) => reportLocalSave(update({ runningSend: value }))}
            hint={t('无法引导时直接发送或排队，不会打断当前一轮。长按发送键可临时选择其他方式。')} />
        </SettingGroup>

        {screenError && <Note tone="error" message={screenError} />}
        {backgroundError && <Note tone="error" message={backgroundError} />}
        {(keepScreenOn !== null || native) && (
          <SettingGroup title={t('设备')}>
            {keepScreenOn !== null && (
              <SwitchRow icon={Sun} title={t('屏幕常亮')} checked={keepScreenOn} disabled={savingScreen}
                hint={t('在应用位于前台时保持屏幕点亮。')} onChange={(value) => void changeScreen(value)} />
            )}
            {native && (
              <SwitchRow icon={Wifi} title={t('后台保持连接')} checked={background} disabled={savingBackground}
                hint={t('切到后台或锁屏后保持电脑连接，继续处理已排队消息。')} onChange={(value) => void changeBackground(value)} />
            )}
          </SettingGroup>
        )}

        {error && <Note tone="error" message={error} />}
        <SettingGroup title={t('关于与更新')}
          footnote={t('QingCode Next 是第三方客户端，与 OpenAI、Anthropic 无隶属关系。Agent 用量计入你自己的账号。')}>
          <div className="qn-setting-row">
            <RowIcon icon={Info} />
            <RowText title="QingCode Next" />
            {version && <span className="qn-setting-value">{version}</span>}
          </div>
          {online && (
            <div className="qn-setting-block">
              <Field label={t('更新地址')} hint={t('填写你信任的 HTTPS APK 下载地址。')}>
                <input className="qn-input" type="url" value={url} disabled={busy !== null}
                  onChange={(event) => { setUrl(event.target.value); setCandidate(null) }}
                  autoCapitalize="off" spellCheck={false} placeholder="https://…" />
              </Field>
              {candidate?.available && candidate.id ? (
                <Button className="w-full" variant="primary" disabled={busy !== null} onClick={() => void install(candidate.id)}>
                  {busy === 'install' ? t('正在检查安装包…') : t('安装 {version}', { version: candidate.versionName })}
                </Button>
              ) : (
                <Button className="w-full" variant="primary" disabled={busy !== null || !url.trim()} onClick={() => void check()}>
                  {busy === 'check' ? t('正在下载并验证更新…') : t('检查更新')}
                </Button>
              )}
            </div>
          )}
          {native && (
            <button type="button" className="qn-setting-row qn-setting-link" disabled={busy !== null} onClick={() => void install()}>
              <RowIcon icon={Download} />
              <RowText title={t('从本地 APK 更新')} />
              <ChevronRight className="qn-setting-chevron" size={18} aria-hidden />
            </button>
          )}
        </SettingGroup>
      </div>
    </Dialog>
  )
}
