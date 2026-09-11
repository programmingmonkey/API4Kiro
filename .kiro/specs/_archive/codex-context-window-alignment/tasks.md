# Implementation Plan

> ✅ **状态：已完成并发布** —— 4.13.55（窗口口径 272000 + GPT-6 判定兜底）、4.13.57（审查收口补接两处构造点）已安装。
> 未归档：作为在役记录保留（这是每日在用的那处修复）。

: Codex 上下文窗口口径统一

## Overview

按"先立出口（覆盖字段）→ 再接线路由 → 再修权威数值 → 最后验证落地"的顺序推进。改动集中在三个源文件（`src/providers.ts`、`src/modelStore.ts`、`src/oauth/vendors.ts`）加一处 IDE 配置（Kiro `settings.json` 的 `p3`），最后重建并安装扩展。

## Task Dependency Graph

```json
{"waves":[{"id":0,"tasks":["1.1","2.1","2.2"]},{"id":1,"tasks":["1.2"]},{"id":2,"tasks":["3.1"]},{"id":3,"tasks":["3.2","4.1"]},{"id":4,"tasks":["4.2"]}]}
```

## Tasks

- [x] 1. 补上 contextWindow 手动覆盖能力
  - [x] 1.1 `src/providers.ts`：`ModelOverride` 增加 `contextWindow?: number` 字段与注释
  - [x] 1.2 `src/modelStore.ts`：在 `normalizeModel`、`vendorCatalog`、`stubModels`、官方在线清单四处把 `ov?.contextWindow` 插到"上游声明"之下、目录/厂商表之上
- [x] 2. 修正权威数值与推理判定兜底
  - [x] 2.1 `src/oauth/vendors.ts`：`codex.models` 按 `codex_client_models.json` 修正窗口（5.5→272000、5.3-codex-spark→128000、5.6 系补 272000）
  - [x] 2.2 `src/modelStore.ts`：`looksReasoningModel` 名字兜底加法式覆盖 GPT-6 及以后家族
- [x] 3. 验证
  - [x] 3.1 `npx tsc --noEmit` 通过；纯函数断言覆盖 Property 1/3/4/5/7
  - [x] 3.2 `node esbuild.js` 构建成功（以现有 `dist/extension.js` 中的 Antigravity secret 注入，构建后比对一致）并打包 vsix
- [x] 4. 落地
  - [x] 4.1 Kiro `settings.json` 的 `p3` provider 补 `modelOverrides`（5 个模型钉 272000）
  - [x] 4.2 `kiro --install-extension` 安装新 vsix，确认 `gpt-6-astra` 窗口报 272000 且思考档位可见（4.13.55 已安装；重载后经 CPS `ListAvailableModels` 实测：5 个模型全部 272000、reasoning/image 标志保留。未重载时曾复现旧值 1050000）

## Notes

- 本仓库开源精简后无测试框架，验证依赖类型检查 + 一次性断言脚本 + 端到端确认。
- 范围外：不把 `gpt-6-astra` 加入内置 Codex 厂商目录（属新增模型支持，需另定套餐门控）。
- 2026-09-11 · DSH · 补 ModelOverride.contextWindow 并接线四条 RelayModel 路径；修正内置 Codex 厂商表窗口（5.5/5.6-*→272000、5.3-codex-spark→128000）；推理判定兜底加法式覆盖 GPT-6+；发布 4.13.55。剩余：等待 Kiro 窗口重载后复核 CPS 报出的窗口值。
