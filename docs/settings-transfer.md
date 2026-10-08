# 配置导入与导出

设置页面顶部提供「导入配置 JSON」「导出配置 JSON」，使用当前选中的用户或工作区范围。

用户导出包含全局设置、主题、字体、语言、快捷键、终端配置和持久化本地项目列表。
工作区导出仅包含 `.qingcode/project-settings.json` 的覆盖项，未设置的值继续继承用户配置。
SSH 工作区设置通过已有 SSH/SFTP 会话读取和写入；SSH 连接信息、密码、私钥、信任授权、
打开的文件和终端会话不在导出范围内。导入不会启动终端命令或授予信任。

导出的文件是标准 JSON，格式如下：

```json
{
  "format": "qingcode-settings",
  "version": 1,
  "scope": "project",
  "settings": { "version": 1, "custom": {}, "editor.tabSize": 2 }
}
```

用户范围使用 `scope: "global"`，并包含可选的 `preferences`。导入也接受普通 JSON/JSON5
设置对象（无包装），因此现有的 `default-settings.json` 和工作区设置可以直接导入。
范围或版本不匹配、无效 JSON、无效偏好和存在未保存修改的设置文件会拒绝导入。

导入按顶层键合并，同名键使用导入值，`custom` 按键合并；未涉及的设置和原文件注释保留。
对象和数组类型的设置值按整个键替换。项目列表按本地路径合并，不移除已有记录；
显式导入不受 `qingcode.projects.syncOnStartup` 限制，不可用的新路径会报告在
`skippedProjects` 中。设置文件仍保留这些路径，便于修正后再次导入。

CLI 与界面使用相同实现，需要 QingCode 正在运行：

```powershell
QingCode.exe settings export --scope user --output C:\backup\qingcode.json
QingCode.exe settings import --scope user --json C:\backup\qingcode.json
QingCode.exe settings export --scope workspace --project D:\project --output C:\backup\workspace.json
QingCode.exe settings import --scope workspace --project D:\project --json C:\backup\workspace.json
```

`--scope` 默认 `user`。工作区省略 `--project` 时使用 GUI 当前项目，也可传入项目 ID、
完整路径或唯一名称。`--json -` 从标准输入读取。`--output` 拒绝覆盖已有文件；
省略它时返回标准 `{ ok, data }`，仅保存 `data` 对象才能再次导入。
退出码：0 成功，1 操作失败，2 参数错误，3 QingCode 未运行。

设置中的 **AI CLI skills** 已包含这些命令；复制或重新安装 Skill 后即可供 AI 使用。

## 恢复默认设置

设置顶部的「恢复默认设置」作用于当前选中的用户或工作区范围，确认弹窗会说明影响范围。
用户范围重置全局配置、自定义设置、主题、字体、语言、快捷键和终端配置，保留持久化项目记录、
工作区配置、信任授权和会话数据。工作区范围清空该项目的覆盖项及自定义设置，重新继承用户配置，
而非写入一份会覆盖用户偏好的完整默认值。未保存的设置标签会阻止重置。
重置也可修复格式损坏的配置文件；写入成功后才应用界面偏好。

```powershell
QingCode.exe settings reset --scope user --yes
QingCode.exe settings reset --scope workspace --project D:\project --yes
```

CLI 需要运行中的 QingCode，必须显式提供 `--yes`；省略它时退出码为 2，且不会发出重置请求。
AI 仅应在用户明确要求恢复默认时使用该命令，需要备份时可先导出配置。
