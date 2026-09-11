# Requirements Document

## Introduction

上一轮已确认：`gpt-6-astra` 在用户的 ChatGPT Plus 账号上**实测可调**（经 CLIProxyAPI 中转 HTTP/SSE 双通），且 Codex 客户端元数据给出 `context_window = 272000`。但 API4Kiro 的**内置 Codex 厂商目录**（OAuth 直连通道）里没有它，用户只有走中转才有 astra。

同时暴露出一个构建期隐患：`esbuild.js` 在取不到 Antigravity client secret 时**静默注入空串**，而本机 `antigravity.secret` 已丢失（现有产物里的 secret 是历史构建烤进去的）。一旦重建，Antigravity 登录会无声失效。

本 spec 覆盖这两项独立收尾：目录上架 + 构建防呆。

## Glossary

| 术语 | 含义 |
|---|---|
| 内置 Codex 厂商目录 | `src/oauth/vendors.ts` 中 `codex.models`，供 `auth=oauth` 的 Codex 直连通道使用 |
| 套餐门控 | `codex.modelsFor(tok)`，按 token 里的 `chatgpt_plan_type` 裁剪可用模型 |
| Antigravity secret | Google OAuth client secret（`GOCSPX-` 开头），不进公开源码，构建时由 `esbuild.js` 注入 |
| 产物 | `dist/extension.js`，esbuild 打包出的单文件 bundle |

## Requirements

### 1. 内置 Codex 目录新增 GPT-6 Astra

**User Story:** 作为用 ChatGPT 订阅直连 Codex 的 Kiro 用户，我希望内置通道里就能选到 `gpt-6-astra`，这样不必额外跑一个中转网关。

#### Acceptance Criteria

1. WHEN 内置 Codex 厂商目录被枚举 THE SYSTEM SHALL 包含条目 `id="gpt-6-astra"`、显示名 `GPT-6 Astra`、`reasoning=true`、`image=true`、`contextWindow=272000`。
2. WHEN 账号套餐为 `plus` 或 `pro` THE SYSTEM SHALL 在可用模型列表中包含 `gpt-6-astra`。
3. WHEN 账号套餐为 `team`、`business`、`enterprise` 或 `edu` THE SYSTEM SHALL 在可用模型列表中包含 `gpt-6-astra`。
4. WHEN 账号套餐为 `free` THE SYSTEM SHALL 不在可用模型列表中包含 `gpt-6-astra`。
5. WHEN 套餐字段缺失或无法识别 THE SYSTEM SHALL 返回全部内置模型（含 `gpt-6-astra`）。
6. WHILE 套餐门控生效 THE SYSTEM SHALL 保证 `modelsFor` 返回的每个条目都属于 `codex.models`（不引入目录外条目）。

### 2. 构建期阻止 Antigravity secret 静默丢失

**User Story:** 作为维护者，我希望构建在会悄悄丢掉 Antigravity client secret 时直接失败，这样登录失效不会变成没有任何提示的静默回归。

#### Acceptance Criteria

1. WHEN 现有 `dist/extension.js` 已内嵌 `GOCSPX-` 开头的 secret AND 本次既未设置 `A2K_ANTIGRAVITY_CLIENT_SECRET` 环境变量也不存在 `antigravity.secret` 文件 THE SYSTEM SHALL 以非零退出码终止构建，且不覆盖现有产物。
2. WHEN 上述守卫触发 THE SYSTEM SHALL 打印可操作提示：说明后果、给出设置环境变量或写回文件两种修法、并给出"确实要构建无 secret 的包则先删除产物"的出路。
3. WHEN 两个来源都取不到 secret AND 现有产物里也不含 secret THE SYSTEM SHALL 打印警告并继续构建（保留"从源码构建者无需 secret"这一既有路径）。
4. WHEN 通过环境变量或 `antigravity.secret` 取到 secret THE SYSTEM SHALL 将其注入产物。
5. WHEN 打印任何构建信息 THE SYSTEM SHALL 不回显 secret 原文。

> 追加修正：Requirement 3 为本轮新增，见文末。

### Requirement 3: 构建期识别形状不对的 secret 值

**User Story:** 作为维护者，我希望形状明显不对的 secret 值被当成缺失处理，这样不会因为误取了别处的字面量而把垃圾值烤进产物。

#### Acceptance Criteria

1. WHEN 从环境变量或 `antigravity.secret` 取到的值长度小于 20 THE SYSTEM SHALL 打印警告并按其缺失处理（不把该值注入产物）。
2. WHEN 上述判定为缺失 THE SYSTEM SHALL 继续走 Requirement 2 的守卫判定（旧产物含 secret 则拒绝构建，否则警告后继续）。
3. WHEN 检查现有产物是否已内嵌 secret THE SYSTEM SHALL 只认长度 ≥ 20 的 `GOCSPX-` 值，以免把 `src/log.ts:240` 的日志脱敏正则字面量误判成真实 secret。
