/** 命令面板里的一条命令。id 全局唯一，重复注册时后注册者覆盖先注册者。 */
export type PaletteCommand = {
  id: string
  title: string
  /** 分类，显示为标题前缀（如"视图: 切换侧栏"），也参与搜索与空查询排序 */
  category?: string
  /** 额外搜索词（英文别名、同义词等），不显示 */
  keywords?: string[]
  /** 快捷键提示，任意写法均可（ctrl+shift+p / Ctrl Shift P / mod+,），显示时统一为 Windows 风格 */
  shortcut?: string
  /** 返回 false 的命令不显示；每次打开面板时求值，抛错视为 false */
  when?: () => boolean
  run: () => void | Promise<void>
}
