---
name: commit-push
description: 自动完成git stage、commit、push 代码变更，遵循中文 commit 规范，可选创建 PR
allowed-tools:
  - Bash(git add:*)
  - Bash(git status:*)
  - Bash(git push:*)
  - Bash(git commit:*)
  - Bash(gh pr create:*)
---

## Context
- Current git status: !`git status`
- Current git diff: !`git diff HEAD`
- Current branch: !`git branch --show-current`

## 分支约束（全局）

- **禁止**自动创建、重命名或切换分支（含在 `main`/`master` 上时也不得自动新建 feature 分支）。
- 仅在用户**明确要求**创建/切换分支时，才可执行 `git switch`、`git checkout`、`git branch`、`git checkout -b` 等命令。
- 默认在**当前分支**上 stage、commit、push。

## Commit Message 格式规范

### 模板

```
<type>(<scope>): <subject>

<body>

<footer>
```

### 类型（type）

| 类型       | 说明                         |
| ---------- | ---------------------------- |
| `feat`     | 新功能                       |
| `fix`      | 修复缺陷                     |
| `docs`     | 文档变更                     |
| `style`    | 代码格式（不影响逻辑）       |
| `refactor` | 重构（非新功能、非修复）     |
| `perf`     | 性能优化                     |
| `test`     | 测试相关                     |
| `chore`    | 构建/工具/依赖变更           |
| `ci`       | 持续集成配置                 |
| `revert`   | 回滚提交                     |

### Subject 规则

- type 保留英文，scope 和 description 使用中文
- description 不超过 50 字符，使用动宾短语（「添加 xxx」「修复 xxx」「优化 xxx」）
- 不加句号，不写无意义描述

### 示例

```
feat(用户模块): 添加手机号一键登录功能

- 接入运营商一键登录 SDK
- 支持移动、联通、电信三网
- 登录失败自动降级到短信验证码

Closes #128
```

```
fix(订单): 修复并发下单导致库存超卖的问题

在高并发场景下，原有的库存扣减逻辑存在竞态条件。
改用 Redis 分布式锁 + 数据库乐观锁双重保障。

影响范围：订单服务、库存服务
```

## Your task

1. 确认当前分支；**不要**创建或切换分支。
2. Stage relevant changes (avoid `git add .`).
3. Create a commit message following the format above.
4. Push the **current branch** to origin.
5. Create PR **only if user explicitly asks** (use `gh pr create`).
6. **ONLY output Bash tool calls. NO extra text. NO explanations. Do everything in ONE response.**
