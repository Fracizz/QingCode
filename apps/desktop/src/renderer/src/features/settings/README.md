# T23 设置界面（集成说明）

## 集成点

`features/settings/index.ts` 导出：

| 导出 | 用途 |
|---|---|
| `SettingsPage` | 标题栏下方的整页设置，接收 `onEditTarget(target)` 和 `onRemoveTarget(id)` |
| `useSettings` / `useSetting(selector)` | zustand 设置 store（加载、乐观更新、失败回滚） |
| `openSettings(section?)` / `closeSettings()` / `useSettingsDialog()` | 全局开关状态，供侧栏齿轮按钮与 `Ctrl+,` 快捷键调用 |
| `SETTINGS_SECTIONS` / `filterSettings` | 分类与搜索逻辑（纯函数，已单测） |
| `defaultAppSettings` / `mergeAppSettings` / `agentPrefs` | 默认值、白名单合并、按目标取 Agent 偏好 |

宿主在标题栏下方渲染设置页。工作区在设置打开期间保持挂载：

```tsx
import { SettingsPage, useSettingsDialog } from './features/settings'
import type { SshTarget } from '../../shared/backendApi'

const settingsOpen = useSettingsDialog((state) => state.open)
{settingsOpen && (
  <SettingsPage
    onEditTarget={(target: SshTarget) => setTargetForm({ open: true, editing: target })}
    onRemoveTarget={(id) => void useTargets.getState().remove(id)}
  />
)}
```

`onEditTarget` / `onRemoveTarget` 是可选回调：**不传时对应按钮隐藏**，本卡不实现连接表单与删除确认。
调用 `openSettings(section?)` 可以直接打开指定分类。顶部搜索框按设置标题和关键词匹配。

## 数据形状（`apps/desktop/src/shared/backendApi.ts` 追加）

```ts
type SettingsSendKey = 'enter' | 'ctrlEnter'
type SettingsDensity = 'comfortable' | 'compact'
type SettingsAgentKind = 'codex' | 'claude' | 'pi'
type AgentPrefs = { enabled: boolean; path?: string; configDir?: string }
type AppSettings = {
  general: { sendKey; autoConnectLast: boolean; defaultAgent: SettingsAgentKind; density: SettingsDensity }
  agents: { [targetId]: { codex?: AgentPrefs; claude?: AgentPrefs; pi?: AgentPrefs } }
}
type AppSettingsPatch = { general?: Partial<...>; agents?: { [targetId]: { [agent]?: Partial<AgentPrefs> } } }
```

- 文件：`userData/settings.json`（原子写入，权限 0600；损坏或 JSON 解析失败回退默认值）。
- backend 方法：`settings.get → AppSettings`、`settings.save(partial) → AppSettings`（深合并 + 白名单，未知字段丢弃）、`app.info → { name, version }`（版本来自 `backendConfig.appVersion`）。注册在 `backend/registerSettings.ts`，`backend/index.ts` 只加了一行调用。
- `path` 为空字符串表示清空；`configDir` 只对 Codex（`CODEX_HOME`）/ Claude（`CLAUDE_CONFIG_DIR`）保存，pi 不接受。只存路径字符串，不读取其中内容、不做自动切换/轮换（合规 §3.2）。
- 纯逻辑在 `backend/settings/appSettings.ts` 与 `renderer/features/settings/settingsModel.ts` 各有一份（形状与语义一致）：renderer 不打包 backend 的 Node IO，故刻意不共享文件；改字段需同步两处与 `shared/backendApi.ts`。

## 各设置的消费方（需总管接入）

| 设置 | 消费方式 |
|---|---|
| `general.sendKey` | 输入框 `Composer` 决定 Enter / Ctrl+Enter 的发送与换行行为 |
| `general.autoConnectLast` | 启动时记住上次 `selectedId`，启动时自动连接该目标（凭据仍走既有流程） |
| `general.defaultAgent` | 草稿态新会话的默认 Agent；不可用时按现有置灰逻辑处理 |
| `general.density` | 写入 `html[data-density="comfortable"\|"compact"]`，**只提供 token 钩子**；具体间距/字号覆盖写在 `styles.css`（本卡不改）。store 在 `load()` 与 `update()` 时自动设置 |
| `agents[targetId][agent].enabled` | 新建会话的 Agent 选择器过滤：关闭后不出现 |
| `agents[...].path` | 传给 server：Codex `codex.open { codexPath }`、Claude `codex.open { claudePath, agent:'claude' }`、pi `codex.open { piPath, agent:'pi' }`（T22 的 `piPath` 由并行任务卡添加） |
| `agents[...].configDir` | 由总管在启动目标上的 Agent 进程时，作为该目标进程环境的 `CODEX_HOME` / `CLAUDE_CONFIG_DIR`；不得跨目标复用、不得读取内容 |

## Agent 检测（server 侧）

- `packages/protocol/src/workspace.ts` 追加 `agent.probe`：`params { agent: 'codex'|'claude'|'pi', path? }` → `{ found, path, version?, error? }`。
- `packages/server/src/workspace/agents/**` 实现并登记到 `workspace/index.ts`。按「参数 → PATH → 常见安装目录 → 裸名字」解析，**只运行 `<exe> --version` + 文件存在性检查**（合规 §7 / R9）；Windows 的 `.cmd` 经 `cmd.exe` 启动且去掉路径里的引号；不开会话、不发 prompt、不读凭据、不注入环境变量、不打印子进程输出。
- renderer 经 `features/workspace/serverCall.ts` 的 `serverCall(targetId, 'agent.probe', { agent, path? })` 调用；目标 `target.state !== 'ready'` 时按钮禁用并显示「连接后检测」。

## 手机连接 / 关于

- 侧栏和命令面板的「手机连接」入口打开设置页的手机连接分类。该分类直接渲染 `MobileSettings` 表单，修改后通过「保存设置」提交。
- 关于页写明「QingCode Next 是第三方客户端，与 OpenAI、Anthropic 无隶属关系；所有用量计入用户自己的账号」（合规 §5），并给出开源组件占位。
- 登录说明是静态文案：Codex `codex login`；Claude `claude` + `/login` 或 API key / Bedrock / Vertex，并提示「订阅登录仅限本人自用，推荐 API key」（§3.3）；pi `pi` 完成提供方配置，且标注「pi 不经审批直接执行工具」。不检测凭据、不提供登录入口。

## 假设

1. `SettingsAgentKind` 单独定义含 `pi`，**没有改** `AgentKind`（并行任务卡 T22 正在扩它），避免类型冲突。
2. 「连接」分类只读列出目标，当前分类仅为 SSH 目标显示编辑按钮。
3. 通用及 Agent 设置的开关和下拉即时保存。路径输入在失焦或按 Enter 时提交。保存失败会回滚并显示错误。
4. 主题目前固定深色，浅色置灰标「即将支持」，不写入设置文件。
