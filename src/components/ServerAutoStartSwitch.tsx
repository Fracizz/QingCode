import { useI18n } from '../lib/i18n'
import SettingSwitch from './SettingSwitch'

export default function ServerAutoStartSwitch({ checked, disabled, onChange }: {
  checked: boolean
  disabled?: boolean
  onChange: (checked: boolean) => void
}) {
  const { t } = useI18n()
  return <SettingSwitch label={t('开机自启 Server')} checked={checked} disabled={disabled} onChange={onChange} />
}
