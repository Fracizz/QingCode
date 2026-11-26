# T8 项目存储、凭据存储、旧版数据导入（backend）

范围：只新增/修改 `apps/desktop/src/backend/{projectStore,secretStore}.ts`、`apps/desktop/src/backend/legacy/**`，以及在 `src/backend/router.ts` 注册新方法；`src/main/index.ts` 只允许新增 `secret.encrypt/decrypt` 的 parentPort 处理（几行）；`src/shared/backendApi.ts` 只允许新增类型。其他 backend 文件（T5 负责的 SSH/部署）只读，`target.connect` 使用已保存凭据/`remember` 的接入点若需改 `sshTarget.ts`，改动最小化并在报告里列出。

依据：`docs/mvp.md` §5（projects.*、legacy.*、target.forgetSecret、凭据）、§8。

## 要做

1. `projectStore.ts`：`userData/projects.json`，原子写（tmp+rename），纯函数部分（去重、排序、name 缺省）单测。
2. `secretStore.ts`：`userData/secrets.json`；经 parentPort 调 main 的 `safeStorage.encryptString/decryptString`（请求带 id，超时 5s）；`save/load/remove`。main 侧处理放在独立函数，`safeStorage.isEncryptionAvailable()` 为 false 时返回错误。
3. `legacy/readLegacyDb.ts`：复制 db（含 -wal/-shm）到临时目录→`node:sqlite` 只读打开→读出连接与项目（列可能缺失：`hidden`、`kind`、`connection_id`、`root_path`、`mode` 都要容错）→删除临时文件。先验证 `node:sqlite` 在 Electron 45 可用：`ELECTRON_RUN_AS_NODE=1 apps/desktop/node_modules/electron/dist/electron.exe -e "require('node:sqlite')"`（electron 路径用 `require.resolve('electron')` 求），utilityProcess 内同样可用；不可用就停下报告。
4. `legacy/mapLegacy.ts`：纯函数，旧行 → 目标/项目/指纹/跳过原因（规则见 §8），重点单测（直连条目跳过、auth 映射、时间戳归一、缺列、重复导入幂等）。
5. `legacy/dpapi.ts`：PowerShell 解密（`powershell.exe -NoProfile -NonInteractive -Command -`，脚本从 stdin 读 JSON 数组的 base64 密文，输出 JSON 数组明文；`Add-Type -AssemblyName System.Security`）；非 Windows 返回空。单测可用 PowerShell `Protect` 生成测试密文做往返（仅 Windows 跑，其他平台 skip）。
6. `legacy/importLegacy.ts`：编排 detect/import，写入 targetStore、projectStore、hostKeys（T5 的 `hostKeys.ts`，若尚不存在则按 §5 格式直接写 `known_hosts.json` 并在报告说明）、secretStore。
7. router 注册：`projects.list/save/remove`、`legacy.detect/import`、`target.forgetSecret`。

## 验收

`pnpm --filter @qn/desktop typecheck`、`pnpm exec vitest run apps/desktop/src/backend` 通过；用一个测试里临时生成的旧版结构 SQLite（`node:sqlite` 建表插数据）跑完整 detect→import→再次 import（全部 skipped）流程。

## 补充（总管）

- 方法注册**只写在** `src/backend/registerData.ts` 的 `registerDataMethods(router)` 里，不要改 `src/backend/index.ts`。
- `secretStore.ts` 需导出 `loadSecret(targetId) / saveSecret(targetId, {password?, passphrase?}) / removeSecret(targetId)` 供 T5 使用。
- 主机指纹：T5 并行开发 `src/backend/hostKeys.ts`（导出 `readKnownHosts/writeKnownHosts/checkHostKey/setHostKey`）。若你开发时它还不存在，在 `legacy/` 内实现一个最小的 known_hosts 写入函数（格式见 mvp.md §5：`userData/known_hosts.json`，键 `host:port`，值 `SHA256:...`），并在报告中说明，由总管合并。
- 目标写入用 `targetStore.ts` 的 `readTargets/writeTargets/upsertTarget`；`upsertTarget` 的 id 参数用 `legacy-<旧 id>`。
- main 侧 `secret.encrypt/decrypt` 处理：在 `src/main/` 新建 `secrets.ts` 并在 `src/main/index.ts` 里加一行调用（只加这一处）。
