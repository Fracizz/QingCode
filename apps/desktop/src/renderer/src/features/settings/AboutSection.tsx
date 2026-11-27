import { useSettings } from './settingsStore'
import { InfoBlock, SettingRow } from './fields'

export function AboutSection() {
  const appInfo = useSettings((state) => state.appInfo)

  return (
    <div>
      <SettingRow title="应用名称与版本">
        <div className="text-ui text-qn-text">
          {appInfo?.name ?? 'QingCode Next'}
          <span className="ml-2 font-mono text-ui-sm text-qn-muted">
            v{appInfo?.version ?? '—'}
          </span>
        </div>
      </SettingRow>

      <div className="mt-3 space-y-2.5">
        <InfoBlock title="第三方声明">
          QingCode Next 是第三方客户端，与 OpenAI、Anthropic 无隶属关系；所有用量计入用户自己的账号。
          应用只驱动用户自己已安装、已登录的官方 Agent，不提供登录流程、不保存凭据。
        </InfoBlock>
        <InfoBlock title="开源组件">
          使用 React、Electron、Radix Primitives、Tailwind CSS、lucide-react、zustand 等开源组件；
          各组件的许可证清单将在发版前整理补充。
        </InfoBlock>
      </div>
    </div>
  )
}
