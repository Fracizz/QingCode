# 跨平台运行配置

同一份 `.qingcode/run.json` 可以保存同一个 `dev`，由任务内的 `os` 覆盖适配实际运行系统。
配置文件仍为 JSON。新版兼容旧字段和现有 CLI 语法，不需要迁移旧文件。

## 发现运行配置

运行面板标题栏的「发现运行配置」读取项目根目录和直属子目录的 `package.json scripts`。
选择需要的脚本后点击「导入选中」，将配置追加到 `.qingcode/run.json`；默认每项独立配置，
也可勾选「合并为一个配置（每项独立终端）」。已有相同命令和相对工作目录的任务显示「已导入」。
保存前会重新读取配置，保留原有 ID、任务与各系统覆盖；JSON 格式错误会阻止导入。

生成命令为 `npm/pnpm/yarn/bun run <script>`，目录作为独立 `cwd` 字段保存。
包管理器依次取当前包的 `packageManager`、当前目录锁文件、项目根目录选用的管理器，
没有声明或锁文件时使用 npm。多个不同管理器的锁文件且未显式指定时跳过该包并提示。
可以预览实际脚本内容；发现和导入都不执行命令、不安装依赖、不自动开启会话恢复。
执行仍须通过现有项目信任与路径检查；项目脚本和生命周期钩子应在运行前审阅。

此版本不递归解析 workspace glob，跳过隐藏目录、node_modules、vendor、target、dist、build、out、coverage；
最多扫描 32 个直属子目录，每包最多 100 个脚本，每个 manifest 最多读取 256 KiB。
更深的包可单独作为项目打开。格式错误、读取失败、过大文件和不适合跨平台 Shell 参数的脚本名会显示跳过原因。
本地、WSL UNC 与 SSH 使用原有文件接口；SSH 标识不传给本地文件系统。

```json
{
  "configs": [{
    "id": "dev",
    "name": "dev",
    "tasks": [
      {
        "id": "frontend",
        "name": "前端",
        "type": "command",
        "cwd": "frontend",
        "target": "pnpm dev"
      },
      {
        "id": "backend",
        "name": "后端",
        "type": "command",
        "cwd": "backend",
        "target": ".venv/bin/python manage.py runserver 127.0.0.1:8000",
        "env": { "PYTHONUNBUFFERED": "1" },
        "os": {
          "windows": {
            "target": ".venv\\Scripts\\python.exe manage.py runserver 127.0.0.1:8000"
          },
          "macos": {
            "env": { "APP_ENV": "development" }
          }
        }
      },
      {
        "id": "celery",
        "name": "Celery",
        "type": "command",
        "cwd": "backend",
        "target": ".venv/bin/python -m celery -A app worker --loglevel=info",
        "os": {
          "windows": {
            "target": ".venv\\Scripts\\python.exe -m celery -A app worker --loglevel=info --pool=solo"
          }
        }
      }
    ]
  }]
}
```

示例的目录、Celery 应用名及端口需要按项目调整，并在各执行环境安装自己的依赖。
Celery 官方不支持原生 Windows；示例 `--pool=solo` 仅供项目自行验证开发兼容性，
需要 Linux worker 时通过 WSL 项目运行，不应将 Windows 兼容配置视为官方支持。

## 合并规则

- 任务公共字段作为默认值，`os.windows`、`os.linux`、`os.macos` 可覆盖 `type`、`target`、`cwd`、`env`。
- 普通字段按是否提供直接覆盖。`cwd: ""` 恢复项目根目录，省略则继承公共目录。
- `env` 按变量名合并，系统覆盖优先；空对象不会删除公共变量，空字符串表示变量值为空。
- 可以省略公共命令并仅填写各系统命令；当前系统最终命令为空时，在创建任务终端前报错。
- 缺少对应系统覆盖时使用公共默认值；未知 OS、无效覆盖字段和非字符串环境变量会报错。
- 配置编辑器中的「按系统覆盖（os）」接受覆盖对象 JSON；无效 JSON 会阻止保存。
- 不同项目可以使用相同配置/任务 ID；运行面板及 CLI 的状态、停止按项目隔离。

## 执行环境

| 项目 | 选用的 OS | 执行方式 |
| --- | --- | --- |
| Windows 本地目录 | windows | 本机 CMD / 指定脚本类型 |
| Linux 本地目录 | linux | 本机 Shell / 指定脚本类型 |
| macOS 本地目录 | macos | 本机 Shell / 指定脚本类型 |
| Windows WSL UNC 目录 | linux | `wsl.exe --distribution <路径所属发行版>` |
| SSH 项目 | 远端探测结果 | 已认证的 SSH / 远端服务会话 |

WSL 路径支持 `\\wsl$\Ubuntu\…`、`\\wsl.localhost\Ubuntu\…` 的识别，
实际目录使用所属发行版内的 POSIX 路径，避免落到 Windows 工具链或默认发行版。
WSL 任务在 Linux 登录 Shell 内初始化环境，去除默认 `/mnt/<盘符>/…` Windows PATH 条目，
再设置合并后的任务环境变量。自定义挂载路径或显式 PATH 应使用项目指定的 Linux 工具。
需要 `setsid`（util-linux）及 `readlink` 等基本工具；缺少工具或发行版不可用时查看错误与任务日志。

本地、WSL 和 SSH 执行继续受工作区信任约束。相对目录以项目根目录为准；
任务工作目录、脚本路径须在当前项目根目录内，解析真实路径后拒绝符号链接越界；
本地任务缺少所属项目根目录时直接拒绝启动。
WSL 任务停止时结束其 Linux 进程组，不终止整个发行版。本地终端关闭时先向 PTY 发送
Ctrl+C（POSIX 另发 SIGTERM），给子进程约 1.5 秒自行退出，超时后再强制结束仍存活的子进程；
按进程启动时间校验，避免误杀 PID 被复用的无关进程。退出应用时所有终端共享同一宽限期。
内联命令依然是受信任的任意用户命令，目录检查不构成 Shell 命令沙箱。

Windows SSH 运行任务仍受现有平台限制，会明确提示不支持。macOS SSH 需使用已具备
POSIX 执行能力的连接；远端服务的可用平台与部署资产仍以 [SSH 工作区文档](ssh-workspaces.md) 为准。

## CLI 与服务验证

`run list/get/upsert/remove/start/stop/status` 的语法保持不变。本地 CRUD 无需 GUI；
SSH CRUD 与启动、状态、停止仍需运行中的 QingCode。

`run upsert` 替换完整配置，更新前先 `run get`，保留 ID、公共字段及所有 `os` 覆盖。
前端与原生 CLI 都保留覆盖对象。旧版 QingCode 不认识新字段，旧版编辑保存可能丢失 `os`；
向前兼容指新版读取旧配置，不能保证旧程序理解新配置。

`run start` 异步创建任务，返回原字段及所选 `environment`、任务终端 ID。
`run status` 保留原 `running` / `terminals`，补充各任务 `status`、`exitCode`、
实际 `target`、`cwd`、执行环境；不返回环境变量值。进程存在与服务就绪需要分别验证。

验收应检查前后端实际服务地址、Celery 执行测试任务、停止后进程退出及端口释放，并再次启动。
WSL 服务需从 Windows 验证；SSH 使用远端可达地址或明确配置的端口隧道，当前功能不自动创建隧道。
监听地址取决于实际网络配置，保留项目已验证的设置，不将某一种绑定地址当成所有环境的要求。
