# 个人云主机远程开发

本文分析在可直接访问 TCP 端口的云主机上运行 QingCode Server 的方案。独立端口已有实现，连接和配对步骤见 [Server 端口直连](direct-agent.md)。本文不将个人开发账户远控等同于多租户云开发平台。

## 推荐架构

客户端通过 `https://<IP 或域名>:<端口>` 访问直连网关。HTTPS 工作区操作与 WSS 终端共用端口，默认 `48763`；日常开发不需要 SSH，SSH 可用于初次安装及维护。需要在云安全组、主机防火墙和 NAT 映射中保证实际连接端口可达。

按开发者分配独立系统账户或容器，使用该账户运行网关与 daemon。网关持有证书和配对 Token，daemon 持有 PTY、输出缓冲和文件监听。文件、工具、Git 凭据及 AI CLI 登录环境保留在远端账户中。

IP、域名和端口只定位服务；客户端仍须核对证书指纹并提供配对 Token。TCP/TLS 透传可保留现有证书固定机制。若由 HTTPS 反向代理终止 TLS，须另行设计证书信任及 WebSocket 转发；当前客户端不接受带子路径前缀的服务地址。

## Linux 常驻部署与生命周期

`direct --detach` 在 Linux 使用 `setsid`，不注册开机启动，也不脱离原 systemd cgroup。若网关派生 daemon 后将两者放在同一服务单元，默认的 `KillMode=control-group` 可能在停止网关时一起结束 daemon 和 PTY。

服务管理命令分别管理 daemon 和网关，要求主机运行 systemd，并由管理员安装到已存在的开发账户。以演示账户为例：

```bash
sudo ./qingcode-server service install \
  --name demo245 --user qingcode-cloud-demo --port 48765 \
  --detached-ttl-secs 86400 --idle-exit-secs 86400 --enable --start
```

不带 `--enable --start` 时只安装，不启用或启动服务。安装要求显式指定账户，不创建账户、不开放防火墙，也不在目标主机下载程序；可在客户端准备并验证二进制后上传。

安装文件与运行方式：

1. 程序复制到 `/opt/qingcode/<名称>/qingcode-server`，配置写入 `/etc/qingcode/<名称>.json`，配置不含配对秘密。
2. 创建 `qingcode-cloud-<名称>-daemon.service` 和 `qingcode-cloud-<名称>-gateway.service`。两个进程使用指定开发账户及其家目录，分别处于各自 cgroup，日志进入 journal。
3. 默认状态目录为 `<账户家目录>/.qingcode/cloud/<名称>/run`，也可指定 `--state-dir`。新目录归开发账户所有，私有权限；拒绝符号链接及权限不安全的已有状态目录。
4. daemon 以前台方式启动，显式传入保留时长与空闲退出参数；验证就绪后启动网关。
5. 网关使用 `direct --require-daemon`，只连接托管 daemon，绝不自行派生 daemon。正常手工 `direct` 的自动拉起行为保持不变。

管理命令同样由管理员执行：

```bash
sudo /opt/qingcode/demo245/qingcode-server service status --name demo245
sudo /opt/qingcode/demo245/qingcode-server service restart --name demo245
sudo /opt/qingcode/demo245/qingcode-server service restart --name demo245 --all
sudo /opt/qingcode/demo245/qingcode-server service stop --name demo245
sudo /opt/qingcode/demo245/qingcode-server service start --name demo245
sudo /opt/qingcode/demo245/qingcode-server service uninstall --name demo245
```

`status` 输出两个单元的状态和 PID，不输出 Token。默认 `restart` 仅重启网关，保留 daemon 与终端；`restart --all`、`stop` 和 `uninstall` 会结束此服务托管的终端。卸载停止服务并删除受管的单元、配置和程序，保留状态目录、配对身份和项目。后续可用新程序重新安装，或在重新安装时改变生命周期参数。安装拒绝覆盖已有安装；已被外部修改的受管文件须先人工检查，工具不会覆盖它们。

配对信息需要在远端显式导出，例如：

```bash
sudo -u qingcode-cloud-demo /opt/qingcode/demo245/qingcode-server \
  direct-info --state-dir /home/qingcode-cloud-demo/.qingcode/cloud/demo245/run --include-secret
```

将输出导入客户端「新建 Server 直连」，填写真实连接地址并确认指纹。服务单元已启用不等于整机重启验收完成；daemon 崩溃或整机重启会结束原终端进程，服务恢复只能创建新终端。

手动或 SSH 自动创建的 daemon 默认 detached 保留 3 小时，无客户端且无 PTY 时 10 分钟退出。新建常驻服务默认将两项改为 24 小时，安装时可分别设置为正秒数；`0` 不表示无限保留。服务使用 `Restart=always` 恢复异常退出及空闲退出的 daemon，因此空闲重启也会重新建立网关，已有 daemon 终端不会在空闲退出条件下被回收。保留时长到期的 detached 终端仍会按 daemon 回收规则结束。

## 后续工作顺序

| 优先级 | 工作 | 验收要求 |
|---|---|---|
| 已实现 | Linux 常驻部署与生命周期配置 | 独立服务单元、开机启用、崩溃恢复、日志、保留时长；网关重启保留终端 |
| 2 | Linux 更新和回退 | 当前界面更新仅支持 Windows SSH；Linux 需人工维护。设计同版本检查、摘要校验、配对身份保留及更新影响确认 |
| 3 | 应用端口转发 | 通过已认证链路访问远端 3000/5173/8000 等应用端口，明确来源、目标地址及访问范围 |
| 4 | 设备凭据管理 | 独立凭据、撤销及轮换；当前为一个状态目录一个持久 Token |

当前客户端严格要求 Server 版本相等，不能只凭端口可达或协议版本相同判断可用。纯 Server 升级路径尚未实现。

当前根目录和信任标记由持有配对凭据的客户端提交，PTY 可以使用服务账户可访问的工作目录。项目根检查可保护正常工作区文件操作，不能约束恶意租户的 Shell 权限。多人场景应先通过系统账户或容器隔离。

## 252.245 模拟验收

使用 `192.168.252.245`（CentOS 7 / x86_64）作为可直接访问 TCP 端口的模拟云主机。在独立临时目录部署本机编译的 musl 二进制并校验 SHA-256，使用独立端口 `48765`；现有 `48763` 网关与旧项目服务不参与测试。测试通过直接 HTTPS/WSS 连接远端，不使用 SSH 隧道。

已有原生客户端验收会创建并清理 UUID 项目，覆盖目录、搜索、文件监听与 PTY 重连：

```bash
QC_DIRECT_PARITY_CONFIG=/private/transport-parity.json \
  cargo test --manifest-path src-tauri/Cargo.toml --lib \
  live_ssh_service_and_direct_port_match_on_disposable_project -- --ignored --nocapture
```

私有配置格式及凭据要求见 [直连验证](direct-agent.md#验证)。252.245 当前未安装 Git，本次将其标记为环境依赖缺失；跳过 Git 的通过结果不表示 Git 已验收。首轮使用现有 root 管理账户的临时状态目录；常驻服务安装后，在独立的 `qingcode-cloud-demo` 开发账户下重复完成原生客户端验收。

新增的云主机验收通过本地用户态 TCP 转发器对每个方向的每批数据增加 50ms 延迟，并主动切断该测试的连接。TLS 仍由原生客户端和远端服务端直接完成，代理不解密、不更改主机网络规则：

```bash
QC_DIRECT_PARITY_CONFIG=/private/transport-parity.json \
  cargo test --manifest-path src-tauri/Cargo.toml --lib \
  live_direct_cloud_latency_disconnect_and_security -- --ignored --nocapture
```

如需同时验收真实网关重启，额外设置 `QC_CLOUD_RESTART_BARRIER_DIR` 为一个新的本地目录。测试在断线后写入 `ready.json`（仅 daemon PID 和 PTY ID），等待至多 60 秒。操作者须校验并仅重启本轮测试的网关，保留 daemon、状态目录、证书及 Token，然后创建该目录中的 `continue` 文件。未设置该变量时只验证网络中断，不宣称验证了网关重启。测试结束时通过原始端点清理自己的 PTY 和 UUID 项目。

2026-10-30 在 252.245 上使用 `0.1.14-beta.12` 完成两项原生客户端实测：

| 验证项 | 结果 |
|---|---|
| 嵌套目录、内容搜索、文件变更通知 | 通过 |
| 错误 Token / 固定证书拒绝 | 通过 |
| 未信任写入、项目根及符号链接逃逸拒绝 | 通过 |
| 延迟代理下 1 MiB 文件上传后读回 | 内容及 SHA-256 一致，往返合计约 10.6 秒；仅是本次模拟值 |
| 主动断线后的命令输出恢复和继续输入 | 通过 |
| 真实网关重启后接回 | 网关 PID `4030 → 7284`，daemon PID `4235`、原 PTY、证书和 Token 保持不变 |
| Git | 未安装，未验证 |

首轮临时服务二进制 SHA-256 为 `0d2fbe706c745e48160411dbd36dfe0aefb02a5f97ce5210928c14baf4013a82`；其测试进程、项目、程序和临时配对秘密已清理。

随后安装的 `demo245` 常驻服务通过 systemd 219 实测：

| 验证项 | 结果 |
|---|---|
| `umask 077` 下管理员安装 | 程序仍为 root 所有、0755；状态目录为开发账户所有、0700；Token 为 0600 |
| 进程身份与隔离 | 指定开发账户运行；daemon、gateway 分属两个 systemd cgroup |
| `service restart` | 仅替换网关 PID；原 daemon、PTY、离线输出和配对身份保留 |
| daemon 主进程被 SIGKILL | daemon 与网关自动恢复就绪；此操作不保留原终端进程 |
| 空闲退出后恢复 | 独立临时服务设为空闲 3 秒，在 60 秒回收检查后退出，约 63.6 秒时两个单元恢复就绪；临时服务已卸载清理 |
| `service stop` / `start` | 两个单元停止后均可重新就绪 |
| `service uninstall` 后重新安装 | 状态目录、证书和 Token 保留，直连可恢复 |
| 最终程序与原生客户端连接 | 文件扫描、WSS HELLO 均通过；网关、daemon、客户端均为 `0.1.14-beta.12` |

最终部署程序 SHA-256 为 `3a1f10c7655613e70225bf04f7420da13a08f8daab42b10996fa0bb0163f4a1a`。演示服务保留运行于 `192.168.252.245:48765`，两个单元已启用开机启动；可打开 `/home/qingcode-cloud-demo/projects/cloud-demo`，运行其中的 `hello.sh`。既有 `48763` 网关与旧项目服务继续运行。未安装系统依赖或修改防火墙。

局域网直连、用户态延迟和连接中断可以验证协议及恢复行为，但不覆盖真实公网路由、云安全组、NAT、长期丢包、桌面安装包或整机重启验收。
