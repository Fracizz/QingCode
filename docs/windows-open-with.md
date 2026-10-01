# Windows「打开方式」

设置 → 功能 → Windows 打开方式，以及 `pnpm register:open-with` / `pnpm unregister:open-with` 使用相同的注册规则：

- 只增加 QingCode 的推荐入口，保留已有默认程序、其他应用的推荐项和文件类型信息。
- `.bat`、`.cmd` 保留 Windows 的执行关联，不注册为 QingCode 的文档类型。它们仍可通过应用内「打开文件」选择并编辑。
- 取消注册隐藏 QingCode 的推荐入口，保留打开命令，避免用户之前主动选择的默认程序变成失效引用。重新注册可恢复入口。
- 不写入 `UserChoice` 或它的校验值，不修改系统级注册表。

旧 PowerShell 脚本的 `New-Item -Force` 会清空现有注册表键的值，造成原有关联丢失。新脚本只创建不存在的键。注册或取消注册时会清理旧版 `.bat` / `.cmd` 的 QingCode 推荐项，以及带有旧版 QingCode 标记的空默认值，让 Windows 重新继承系统关联。迁移版本记录避免之后重复清理用户自己的空默认值。

已经被旧脚本删除的自定义默认值和第三方推荐项无法从现存数据推断恢复。如果用户曾主动把 QingCode 选为默认程序，取消推荐入口也不会替用户重新选择记事本；应在 Windows 的默认应用设置中重新选择所需文本编辑器。

回归测试使用内存注册表执行真实 PowerShell 脚本，覆盖注册、重复注册、取消注册和重新注册，并检查记事本推荐项、`batfile`、其他编辑器、默认命令和 `UserChoice` 均保留。此测试不等同于在受影响 Windows 用户账户上的 Explorer 实测。
