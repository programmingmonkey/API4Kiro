# Implementation Plan

> ✅ **状态：已交付并归档** —— 4.13.56（astra 上架 + 套餐门控 + 构建守卫）、4.13.57（审查收口）已发布并安装。
> 唯一未完成项是 **`antigravity.secret` 需用户自备**（本机无可恢复值），已判定为**外部依赖**并移出任务清单，
> 属「等外部输入」而**不是「决定不做」**；详见下方 Notes。

## Overview

先加目录条目与套餐门控（纯数据），再改构建守卫，然后恢复本机 secret 文件，最后统一验证、递增版本并打包安装。

## Task Dependency Graph

```json
{"waves":[{"id":0,"tasks":["1.1","2.1","2.4"]},{"id":1,"tasks":["1.2","2.3"]},{"id":2,"tasks":["3.1"]},{"id":3,"tasks":["3.2","3.3"]},{"id":4,"tasks":["3.4"]},{"id":5,"tasks":["4.1","4.2"]}]}
```

## Tasks

- [x] 1. 内置 Codex 目录上架 GPT-6 Astra
  - [x] 1.1 `src/oauth/vendors.ts`：`codex.models` 追加 `gpt-6-astra`（GPT-6 Astra / reasoning / image / contextWindow 272000）　_Requirements: 1.1_
  - [x] 1.2 `src/oauth/vendors.ts`：`modelsFor` 的 team|business|enterprise|edu 白名单加入 `gpt-6-astra`，free 分支保持不含　_Requirements: 1.2, 1.3, 1.4, 1.5, 1.6_
- [x] 2. 构建期防呆
  - [x] 2.1 `esbuild.js`：产物已含 secret 而本次取不到时拒绝构建（exit 1，不写产物），并打印可操作提示；两者都没有时警告后继续　_Requirements: 2.1, 2.2, 2.3_
  - [x] 2.3 `esbuild.js`：`define` 改为注入已解析的 secret 变量　_Requirements: 2.4_
  - [x] 2.4 `esbuild.js`：secret 形状阈值校验（<20 字符视为缺失并告警；`SECRET_RE` 加 `{20,}` 以免把 `src/log.ts` 脱敏正则字面量误判成 secret）　_Requirements: 3.1, 3.2, 3.3_
- [x] 3. 验证与发布
  - [x] 3.1 `npx tsc --noEmit` 通过；断言覆盖 astra 条目字段与三个套餐分支的门控（41/41 通过）　_Requirements: 1.1, 1.2, 1.6_
  - [x] 3.2 构建守卫双向验证：有旧 secret + 无来源 → exit 1 且产物哈希不变、提示不回显 secret；无旧 secret → 警告后构建成功　_Requirements: 2.1, 2.2, 2.3, 2.5_
  - [x] 3.3 版本 → 4.13.56，打包 vsix
  - [x] 3.4 `kiro --install-extension` 安装并确认版本（4.13.56）
- [x] 4. Spec 审查收口（F2/F3）
  - [x] 4.1 tasks.md 每条任务补 `_Requirements:_` 引用：`spec_checklist` 的 3 条 unreferenced 已消除；`spec_drift` 仍报 3 条 —— 实测与引用粒度（块级/准则级）及空白字符均无关，判定为其"弱证据"限制（见 Notes）（F2）　_Requirements: 1.1, 1.2, 1.3, 1.4, 1.5, 1.6, 2.1, 2.2, 2.3, 2.4, 2.5, 3.1, 3.2, 3.3_
  - [x] 4.2 design.md 每条 Property 补 `**Validates: Requirements X.Y**`、同步"Components"段里已过期的 `SECRET_RE` 描述、并为注入路径补 Property 7（F3）　_Requirements: 2.4_

## Notes

- **外部依赖（非本次范围，已从任务清单移出）**：本机不存在可恢复的 Antigravity client secret，启用 Antigravity 登录需用户自备并写入仓库根 `antigravity.secret`（gitignore）。此项不影响任何已交付内容，也不阻塞本 spec 的完成判定。
- **F2 收口说明**：`spec_checklist` 已 0 warning；`spec_drift` 对要求 1/2/3 仍报 unreferenced。做了三次对照实验（准则级 `1.1` / 块级 `1` / 全角空格改 ASCII 空格），结果不变，且三处实现均有实测证据（41/41 断言、守卫双向测试、已装产物 grep），故判定为工具侧弱证据限制，非缺失落地。
- **F1 收口**：`seedProviderModels`（`modelStore.ts:519`）与 `catalogFallbackModels`（`:541`）补 `overrideFor` 接线，已随 4.13.57 发布（该修订记录在 `codex-context-window-alignment` 的 Amendments 中）。

- 内置通道 + astra 的端到端可用性需用户登录内置 Codex 厂商通道后确认（当前 Codex 访问走 CLIProxyAPI 中转 `p3`）。
- **未完成项 2.2**：本机不存在可恢复的 Antigravity client secret（4.13.52 安装版与本仓库 4.13.54.vsix 均不含），因此"从产物恢复"不可行，需用户自备该 secret 才能启用 Antigravity 登录。未启用时对现有三个 provider（p1/p2/p3，均 key 类）无影响。
- 4.13.55 曾误把 `src/log.ts` 脱敏正则里的 `GOCSPX-` 字面量当作 secret 注入；4.13.56 已改回空串（与开发者构建的 4.13.54 行为一致），并由新增的阈值校验防止复发。
- 2026-09-11 · DSH · 内置 Codex 目录新增 gpt-6-astra（272000/reasoning/image）并按套餐门控（team/plus/pro 含，free 不含）；esbuild.js 增加构建守卫与 secret 形状阈值校验；发布 4.13.56。未完成：2.2 本机无可恢复 secret，需用户自备。
- 2026-09-11 · DSH · 审查收口：补 _Requirements 引用（spec_checklist 清零）、补 Validates 与 Property 7、同步过期描述；F1 两处 RelayModel 构造点接线并发布 4.13.57。spec_drift 的 3 条弱证据告警经三次对照实验判定为工具限制。
