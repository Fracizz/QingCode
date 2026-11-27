# features/palette — 命令面板（Ctrl+Shift+P / F1）

| 文件 | 作用 |
|---|---|
| `types.ts` | `PaletteCommand`：`{ id, title, category?, keywords?, shortcut?, when?, run }` |
| `registry.ts` | 命令注册表：`registerCommands(cmds) => 注销函数`、`useCommands()`；重复 id 后注册覆盖先注册（开发模式 `console.warn`），注销后先注册的恢复 |
| `match.ts` | 标题 / 分类 / 关键字模糊匹配与打分、高亮切片（纯逻辑） |
| `paletteModel.ts` | `>` 前缀处理、最近使用（最多 20 条）、排序、Windows 风格快捷键显示、键盘移动、命令执行错误收敛（纯逻辑） |
| `paletteStore.ts` | zustand：`open / initialQuery / error / recent`；`openCommandPalette / closeCommandPalette / toggleCommandPalette`；最近使用存 `localStorage['qn-palette-recent']` |
| `CommandPalette.tsx` | 浮层 UI：↑↓ 循环、PageUp/PageDown 翻页、Enter 执行、Esc / 点遮罩关闭、鼠标悬停选中 |
| `defaultCommands.ts` | 内置命令清单，动作全靠依赖注入，未提供的动作不生成命令 |
| `storeDeps.ts` | `storeCommandDeps()`：把全局 store 里现成的动作（停靠栏、侧栏、新会话、中断、设置、添加项目、导入旧版、重新加载）接成依赖 |

## 行为约定

- 输入以 `>` 开头时与旧版一致视为命令模式；本面板只有命令模式，`>` 被忽略。
- 空查询：最近使用在前（按使用先后），其余按分类、标题排序，无分类的排最后。
- 有查询：按空白切词，每个词须在标题 / 分类 / 关键字之一命中；标题权重最高，同分时最近使用优先。未实现拼音首字母匹配。
- `when()` 在打开面板时求值，返回假或抛错的命令不显示。
- 执行时先关面板再 `run()`（命令常会打开别的对话框）。`run` 同步抛错或异步拒绝时：传了 `onError` 走 `onError`；否则重新打开面板，在输入框下方显示错误行。

## 总管接入 App.tsx

```tsx
import { CommandPalette, defaultCommands, registerCommands, storeCommandDeps, toggleCommandPalette } from './features/palette'

// 组件内：登记内置命令。App 局部 state 管的动作在这里补上；
// quickOpen 的可用条件与渲染 <QuickOpen> 的条件保持一致。
const workspaceReady = !('reason' in workspace)
const workspaceReadyRef = useRef(workspaceReady)
workspaceReadyRef.current = workspaceReady
useEffect(
  () =>
    registerCommands(
      defaultCommands({
        ...storeCommandDeps(),
        quickOpen: () => setQuickOpen(true),
        canQuickOpen: () => workspaceReadyRef.current,
        addTarget: () => setTargetForm({ open: true, editing: null }),
        openMobile: () => setMobileOpen(true),
      }),
    ),
  [],
)

// 全局快捷键 onKeyDown 开头加 F1（无修饰键）：
if (event.key === 'F1' && !event.ctrlKey && !event.metaKey && !event.altKey && !event.shiftKey) {
  event.preventDefault()
  toggleCommandPalette()
  return
}
// …原有 `if (!(event.ctrlKey || event.metaKey) || event.altKey) return` 之后，shiftKey 分支里加：
if (key === 'p') {
  event.preventDefault()
  toggleCommandPalette()
  return
}

// JSX 末尾（<Notice /> 旁）渲染一次：
<CommandPalette />
```

想让执行失败走全局提示条而不是面板内错误行，可传 `onError`，例如
`<CommandPalette onError={(message) => useCodex.setState({ notice: message })} />`（`Notice` 会显示 `useCodex.notice`）。

其它 feature 可自行登记命令（组件内 `useEffect(() => registerCommands([...]), [])`，卸载时自动注销）。
