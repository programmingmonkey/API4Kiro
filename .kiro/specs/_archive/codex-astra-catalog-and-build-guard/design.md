# Design Document
> 有修订：见文末 `## Amendments`。

## Overview

两项互相独立的收尾改动，共触及两个文件：

1. **目录上架**：`src/oauth/vendors.ts` 的 `codex.models` 追加 `gpt-6-astra`，并把 id 加进 `modelsFor` 的 team/plus/pro 门控白名单。纯数据改动，不新增机制。
2. **构建防呆**：`esbuild.js` 增加一道守卫 —— 当本次取不到 Antigravity secret 而现有产物里已有它时拒绝构建；另在本机恢复 `antigravity.secret` 文件，让正常构建路径重新自洽。

## Architecture

### 目录上架的数据流

```
Codex OAuth token (plan=plus/team/free)
        ↓
vendorModelsFor(p)  →  codex.modelsFor(tok)  →  codex.models 白名单过滤
        ↓
modelStore.vendorCatalog(p)（已支持 modelOverrides 覆盖窗口）
        ↓
CPS ListAvailableModels → Kiro 模型选择器
```

`modelsFor` 只在拿到 token 时生效（`vendorModelsFor` 里判 `tok && spec.modelsFor`），因此新增条目对未登录场景无影响。

### 构建守卫的数据流

```
readAntigravitySecret()
   ├─ 环境变量 A2K_ANTIGRAVITY_CLIENT_SECRET   → 有则用
   ├─ 文件 antigravity.secret                  → 有则用
   └─ 都没有
        ├─ 现有 dist/extension.js 含 GOCSPX-… → 拒绝构建（exit 1，不写产物）
        └─ 现有产物也不含                      → 警告 + 继续（contributor 路径）
```

守卫必须在 esbuild 写出产物**之前**判定，因此放在模块顶层、`options` 构造之前；命中时用 `process.exit(1)`，不进入构建。

## Components and Interfaces

### `src/oauth/vendors.ts`

- `codex.models: VendorModel[]` —— 追加 `{ id: "gpt-6-astra", name: "GPT-6 Astra", reasoning: true, image: true, contextWindow: 272000 }`，置于数组末尾（与 5.6 系当初追加的方式一致，不改变既有条目顺序）。
- `codex.modelsFor(tok)` —— `team|business|enterprise|edu` 分支的白名单追加 `"gpt-6-astra"`；`free` 分支保持不变；默认分支 `return codex.models` 自动包含。
- 白名单通过既有 `only(ids)` 过滤 `codex.models`，天然满足"返回值必属于 `codex.models`"。

### `esbuild.js`

- 新增 `OUT_FILE = "dist/extension.js"`、`SECRET_RE = /GOCSPX-[A-Za-z0-9_-]{20,}/` 与 `MIN_SECRET_LEN = 20`（阈值见文末 Amendments：避免误命中 `src/log.ts` 的脱敏正则字面量）。
- 新增 `secretInExistingBundle(): string` —— 读现有产物取 secret，读不到返回空串（不抛）。
- `readAntigravitySecret()` 保持原语义（环境变量优先、文件其次、都没有返回空串）。
- 顶层守卫：`const antigravitySecret = readAntigravitySecret();` 若为空且 `secretInExistingBundle()` 非空 → 打印提示并 `process.exit(1)`；若为空且现有产物也无 → `console.warn` 后继续。
- `define` 改为注入 `antigravitySecret`（原来是就地调用 `readAntigravitySecret()`）。
- 所有输出只描述状态，不回显 secret 原文。

## Data Models

### `VendorModel` 新增条目

| 字段 | 值 | 依据 |
|---|---|---|
| `id` | `gpt-6-astra` | gateway 目录 / models.dev / Codex 元数据三处一致 |
| `name` | `GPT-6 Astra` | 与该表既有命名风格一致（如 `GPT-5.6 Sol`） |
| `reasoning` | `true` | models.dev `reasoning: true`；档位含 low/medium/high/xhigh/max，实测 `max` 返回 200 |
| `image` | `true` | Codex 元数据 `input_modalities: [text, image]`；models.dev `input: [text, image, pdf]` |
| `contextWindow` | `272000` | Codex 客户端元数据 `context_window`，与 5.5 / 5.6 系同口径 |

### 套餐 → 模型白名单（`modelsFor`）

| 套餐 | 是否含 astra | 依据 |
|---|---|---|
| `free` | ✗ | gateway `codex-free` 列表无 astra |
| `team` / `business` / `enterprise` / `edu` | ✓ | gateway `codex-team` 含 astra |
| `plus` / `pro`（默认分支） | ✓ | gateway `codex-plus` / `codex-pro` 含 astra |
| 未知 / 缺失 | ✓ | 默认分支返回全部 |

### 构建守卫的判定输入

| 输入 | 取值 | 说明 |
|---|---|---|
| `A2K_ANTIGRAVITY_CLIENT_SECRET` | 字符串 \| 空 | 优先级最高 |
| `antigravity.secret` 文件 | 字符串 \| 空 | 次级来源，gitignore 的本机文件 |
| 现有 `dist/extension.js` 内嵌 secret | `GOCSPX-…` \| 空 | 仅用于守卫判定，不参与注入 |

## Correctness Properties

### Property 1: astra 条目字段正确

`codex.models` 中存在 `id === "gpt-6-astra"` 的条目，且 `reasoning === true`、`image === true`、`contextWindow === 272000`、`name === "GPT-6 Astra"`。

**Validates: Requirements 1.1**

### Property 2: 套餐门控正确

`modelsFor({ plan: "plus" })` 与 `modelsFor({ plan: "team" })` 均包含 `gpt-6-astra`；`modelsFor({ plan: "free" })` 不包含。

**Validates: Requirements 1.2, 1.3, 1.4, 1.5**

### Property 3: 门控不引入目录外条目

对任意 plan 取值（含未知/空），`modelsFor(tok).map(m => m.id)` 均为 `codex.models.map(m => m.id)` 的子集。

**Validates: Requirements 1.6**

### Property 4: 守卫在危险路径上失败且不写产物

给定"环境变量为空 + 文件缺失 + 现有产物含 ≥20 字符的 `GOCSPX-` 值"，构建进程以非零码退出，且产物字节不变。

**Validates: Requirements 2.1, 2.2, 3.3**

### Property 5: 守卫在安全路径上放行

给定"环境变量为空 + 文件缺失 + 现有产物不含 secret"，构建继续并在 stdout 给出警告。

**Validates: Requirements 2.3**

### Property 6: secret 原文不回显

在 secret 存在与缺失两种构建路径下，打印内容均不含 `GOCSPX-` 原文。

**Validates: Requirements 2.5**

### Property 7: 取到 secret 时注入产物

给定一个形状合法的 secret（环境变量注入），构建产物中该值可被检出。

**Validates: Requirements 2.4**

## Error Handling

- 守卫触发时**不写产物**：`process.exit(1)` 发生在 `esbuild.build()` 之前，旧 bundle 保持原样，不会产生"半坏"的构建结果。
- `secretInExistingBundle` 用 `try/catch` 包裹读取（文件不存在属正常路径，不是错误）。
- 提示文案给出三条出路：设环境变量、写回 `antigravity.secret`、或删除产物明确表示要构建无 secret 的包。

## Testing Strategy

1. 静态：`npx tsc --noEmit`。
2. 纯函数断言（复用上一轮的 `vscode` stub bundle 方案）覆盖 Property 1/2/3。
3. 构建守卫双向验证覆盖 Property 4/5/6/7：有旧 secret 且无来源时必须失败且产物哈希不变；无旧 secret 时警告后构建成功；注入形状合法的 fake secret 时产物中可检出该值（验证后即清除，最终产物不得含任何 ≥20 字符的 `GOCSPX-` 值）；各次构建的打印内容均不含 secret 原文。
4. 端到端：版本号递增 → 打包 vsix → `kiro --install-extension` → 确认安装版本。

## Risks

- **R1**：`gpt-6-astra` 在 free 档被排除的依据来自 CLIProxyAPI 的公开目录（`codex-free`），并非 OpenAI 官方文档；若实际 free 档可用，影响仅为"少一个可选项"，不会报错。
- **R2**：内置 Codex 通道的 astra 可用性无法在本机端到端验证 —— 用户的 Codex 访问走的是 CLIProxyAPI 中转（`p3`），并未在 API4Kiro 里登录内置 Codex 厂商通道。已通过中转实测证明该账号能用 astra，但"内置通道 + astra"这一组合留给用户登录后确认。
- **R3**：`antigravity.secret` 是 gitignore 的本机文件，换机器/清目录后仍需自备；本次守卫只能保证"丢失时不再静默"，不能替用户保管 secret。

## Amendments

> 补充修正

### 2026-09-11 · 认定本机无可恢复 secret，守卫增加形状阈值

实施过程中查到的事实：**本机不存在可恢复的 Antigravity client secret** —— 已安装的 4.13.52、仓库里的 `api2kiro-dual-4.13.54.vsix`、以及当时的 `dist/extension.js` 里都没有 ≥20 字符的 `GOCSPX-` 值；最初 `grep GOCSPX` 命中的那个字面量来自 `src/log.ts:240` 的日志脱敏正则 `/GOCSPX-[A-Za-z0-9_-]{10,}/`。

由此产生两处设计调整：

1. `SECRET_RE` 由 `/GOCSPX-[A-Za-z0-9_-]+/` 改为 `/GOCSPX-[A-Za-z0-9_-]{20,}/`，否则脱敏正则字面量会让守卫在正常构建时误报（contributor 首次构建后再重建会被无理由挡住）。
2. `readAntigravitySecret()` 增加长度阈值（`MIN_SECRET_LEN = 20`）：形状不对的值按缺失处理并告警。这正是本次险些踩进去的坑——把一个 7 字符字面量当 secret 注入了产物。

任务 2.2（"从现有产物恢复 secret"）据此判定为**不可行**，转为"需用户自备"，保留为未完成任务并在 Notes 中说明。源码注释本身也已声明：未提供 secret 时 Antigravity 登录需自备 Google OAuth client（`src/oauth/vendors.ts:612-616`）。
