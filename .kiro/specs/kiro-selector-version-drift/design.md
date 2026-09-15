# Design: 选择器补丁靶点结构化重锚

## Overview

Kiro 1.1.14 重新压缩了 `kiro-ui-agent-chat` 的 webview bundle，而 `src/selectorStyle.ts` 的选择器
补丁靶点用**逐字压缩串**锚定（基准为 Kiro 1.0.411 / 1.0.437）。三处选择器锚点全部失配，
`applySelectorScript()` 按「全有或全无」放弃整文件，`selectorScript` 报 `unavailable`，
`syncGroupHeaderStyleUnlocked()` 又据此连带放弃 CSS 靶点，最终浮出
`model selector target not found in mermaid-*.js (Kiro version drift); style not applied`。

本设计把六个 mermaid 靶点的定位方式从「逐字匹配压缩名」换成
**标识符屏蔽结构匹配（identifier-masked structural match）**：压缩器的唯一自由度是改名，
所以把模板与真机文本的标识符都换成哨兵后逐字比对，即可在不依赖任何压缩名的前提下确认结构等价，
并顺带导出一份「规范名 → 真机名」映射，用于把整份补丁模板渲染成真机形态。
规范模板字面量不改（继续以 1.0.411 压缩名书写），只改「怎么找」。

范围限定为 `src/selectorStyle.ts` 的查找路径 + 一处 detail 文案；
三态分类、提交顺序、「全有或全无」与回滚语义全部保持不变。

## Glossary

| 术语 | 含义 |
| 靶点（target） | 一个需要被改写的位置，如「选项行 className 表达式」 |
| 规范模板（canonical template） | 以 1.0.411 压缩名书写的字符串常量，如 `ORIG_JS_PATTERN` |
| 压缩名 | Kiro 构建时压缩器生成的名字（`E` / `n2e` / `x2e` …），每次构建都变 |
| mask / 屏蔽 | 把每个标识符 token 替换为哨兵 `U+0000` 后的文本 |
| 出厂文本 | Kiro 安装自带、未被本插件改写的文本（不含任何 `a2k-`） |
| 全有或全无 | 三处选择器靶点任一不命中则整文件一字不写 |

## Bug Details

受影响的靶点与实测命中情况（对真机 bundle 只读副本运行 `__selectorStyleInternals`）：

| 靶点 | 锚定串 | 真机命中（1.1.14） |
| --- | 选项行 | `ORIG_JS_PATTERN` | 否 |
| 菜单容器 | `ORIG_MENU_PATTERN` | 否 |
| 选中项 ref | `ORIG_REF_PATTERN` | 否 |
| 触发器 | `ORIG_TRIGGER_PATTERN` | 是 |
| 弹层函数 | `ORIG_POPOVER_PATTERN` / `findPopoverFactory` | 否 / `null` |
| 弹层调用处 | `ORIG_POPOVER_CALL_PATTERN` | 否 |
| 上下文下拉调用处 | `findEffortSelectorCall` | 否 |

失败链路：

1. `applySelectorScript()` 的 `selectorHit` 要求选项行 / 菜单 / ref **全中**，不中即 `return content`。
2. `planModelSelectorScript()` 见 `enabled && !patchedPresent` → 报 `unavailable`。
3. `syncGroupHeaderStyleUnlocked()` 取 `styleEnabled = enabled && selectorScript.status !== "unavailable"`
   → 连带放弃 CSS 写入。
4. 浮出 `detail = "model selector target not found in mermaid-*.js (Kiro version drift); style not applied"`。

真机当前状态：`mermaid-GHXKKRXX-pooCyKz9.js` 与 `style.css` 均无 `a2k-` 标记（出厂态），
而 `dist/extension.js` 残留 `__kiroModelConfigProvider=t` 与 `a2k-ctx` 钩子
（后端靶点走的是结构锚点，在 1.1.14 上仍能命中）。

### 报错文案的误导

detail 指出的两条处置动作均与实测不符：

- 「检查 Kiro 安装目录是否可写」：`dist/assets/` 对当前用户可写（create / delete 均成功）。
- 「重装 / 更新 Kiro 会恢复出厂文件」：`codesign --verify /Applications/Kiro.app` 早已返回
  `a sealed resource is missing or invalid`（上一次写 `dist/extension.js` 所致）。
  重装只会抹掉当前**仍在生效**的后端钩子，却不会修复锚点漂移。

## Hypothesized Root Cause

压缩器在 1.1.14 重排了同一表达式内的局部名，而锚点串把这些名字写死在字面量里：

| 位置 | 1.0.437 | 1.1.14 |
| --- | 选项行 name 变量 | `name:E` | `name:w` |
| 选项行 rate 变量 | `R` | `I` |
| 选项行 meta 取值函数 | `p(y)` | `f2e(y)` |
| map 形参遮蔽 | `O` | `N` |
| ref 回调形参 | `O` | `N` |
| 弹层函数 / 警告函数 | `Bde` / `Pde` | `n2e` / `t2e` |
| React Compiler cache | `re.c(30)` | `ne.c(20)` |
| `useSessionConfig` | `l0` | `E0` |
| EffortSelector | `a0e` | `x2e` |

### 实测事实（本设计成立的基础）

把模板与真机文本的标识符统一替换为哨兵后逐字比对：

```
ORIG_JS_PATTERN              raw=false  masked=@846686   count=1
ORIG_MENU_PATTERN            raw=false  masked=@846522   count=1
ORIG_REF_PATTERN             raw=false  masked=@832592   count=7
ORIG_TRIGGER_PATTERN         raw=true   masked=@846334   count=1
ORIG_POPOVER_PATTERN         raw=false  masked=@842317   count=1
ORIG_POPOVER_CALL_PATTERN    raw=false  masked=@845056   count=1
```

即：**六份规范模板在 1.1.14 里除压缩名外逐字未变**。压缩只改名，不改结构、不改属性名、
不改字符串字面量、不改数字。这正是可以拿「标识符屏蔽后比对」当结构匹配器的依据。

弹层函数体另做逐 token diff：canon 2361 字符 vs 1.1.14 2332 字符，41 处差异全部是标识符 1:1 改名
（`Bde→n2e`、`re→ne`、`Pde→t2e`、`E→w`、`R→I`、`O→N`、`I→R`、`B→$`、`z→H`），
外加模板尾部多带的 `a(Bde,"ContextUsagePopover");`（29 字符）。无一处是语句 / 属性 / 文案差异。

## Expected Behavior

- 六处 mermaid 靶点在结构未变时按屏蔽匹配命中，不再因压缩名变化而放弃。
- 命中后写入的补丁使用真机的压缩名，模型选择器卡片化分组样式可见。
- 靶点结构确实被改写（而非仅改名）时报 `unavailable` 且一字不写，保持全有或全无。
- 关闭代理 / 停用插件时把全部 `a2k-` 注入还原为出厂，产物与出厂文件逐字一致。
- 失败 detail 指向「Kiro 重新压缩了 webview bundle」，不再指向目录权限或重装 Kiro。

## Correctness Properties

### Property 1: 跨压缩名等价（结构等价）

对任意把标识符一致改名的文本 `t`，`matchMasked(t, canonical)` 必须命中；
`renderMatched(PATCHED_CANON, canonical, span)` 渲染结果里的标识符与 `t` 一致。
以真机 1.1.14 bundle 为 fixture 断言六处全部命中且次数为 1。

**Validates: Requirements R2.1.**（不再因压缩名变化而放弃；靶点 #1–#6）

### Property 2: 唯一命中（结构等价）

命中一处以上时 `matchMasked` 返回 null，调用方据此报 `unavailable`（全有或全无）。

**Validates: Requirements R3.1.**（全有或全无；靶点 #3 的 ref 写法在 bundle 中出现 7 次）

### Property 3: 映射守卫（结构等价）

同一规范名映射到两个实际名、或两个不同规范名撞同一实际名时，`renderMatched` 返回 null，
且 `applySelectorScript` 一字不写。

**Validates: Requirements R2.4.**（结构确实被改写时一字不写）

### Property 4: 不误伤（结构等价）

打补丁后 `a2k-` 只出现在预期靶点；非靶点区域逐字不变。

**Validates: Requirements R3.5.**（只改三个靶点文件；靶点不命中不追加 CSS）

### Property 5: 幂等（往返）

`apply(apply(x)) === apply(x)`；`restore(restore(x)) === restore(x)`。
同步器靠「往返后逐字相同则本轮不写」判定 `unchanged`，幂等是它的前提。

**Validates: Requirements R3.4.**（enabled=false 时尽力还原；planModelSelectorScript 的 unchanged 分支）

### Property 6: 往返复原（往返）

对出厂 1.1.14 文本 `x`，`restore(apply(x)) === x` 逐字成立。

**Validates: Requirements R2.3.**（还原为出厂内容，产物与出厂文件逐字一致）

### Property 7: 历史变体还原（往返）

对 1.0.411 / 1.0.437 形态的历史补丁文本，`restore` 仍能回到出厂。

**Validates: Requirements R1.4.**（关闭代理 / 停用插件时把 1.0.411 形态的残留也清掉）

### Property 8: 开启端到端（真机）

真机 1.1.14 copy 上 `syncGroupHeaderStyle(true)` 返回 `status === "applied"`，
`targets.selectorScript` / `targets.style` / `targets.backend` 均为 `applied`，且无 detail。

**Validates: Requirements R2.2.**（用户看到模型选择器卡片化分组样式；报错消失）

### Property 9: 关闭端到端（真机）

紧接着 `syncGroupHeaderStyle(false)` 返回 `status === "removed"`，
且 `mermaid-*.js` / `style.css` 与出厂原文逐字一致。

**Validates: Requirements R2.3.**（任意受支持版本上关闭都还原为出厂）

### Property 10: 出厂态空转（真机）

出厂态上调 `syncGroupHeaderStyle(false)` 报 `unchanged`，文件 mtime 不变。

**Validates: Requirements R3.4.**（不产生无意义写入）


### Requirements Validation Map

需求编号按 bugfix.md 的小节顺序登记：**R1 = Current Behavior (Defect)**、
**R2 = Expected Behavior (Correct)**、**R3 = Unchanged Behavior (Regression Prevention)**。
每条 Property 末尾的 `**Validates: Requirements R?.?**` 即为对应关系。

## Fix Implementation

> **实现期修正见文末《Amendments》**：定位实现已由「identifier-masked indexOf」改为「非标识符逐字 + 标识符各自通配的结构正则」，并有三处实现期才暴露的坑（模板串反引号、规范串尾部标签、补丁模板自带局部名撞车）。

### 1. 标识符屏蔽匹配器

```ts
type MaskedSpan = { start: number; end: number; text: string; names: Map<string, string> };

function scanMasked(content: string, canonical: string): MaskedSpan[];   // 全部命中
function matchMasked(content: string, canonical: string): MaskedSpan | null; // 唯一命中
function renderMatched(template: string, canonical: string, span: MaskedSpan): string | null;
```

- `mask(s)`：`s.replace(/(?<![\w$])[A-Za-z_$][\w$]*/g, "\u0000")`。
  沿用文件已有标识符正则同源写法；哨兵替换为**单字符**，保证屏蔽后长度不变，
  `indexOf` 偏移可直接用于原文切片。
- 哨兵取 `U+0000`：JS 源码不可能出现，不会与真实字符混同。
- 映射导出：命中段与模板的标识符 token 序列长度必相等，按位置 zip 得到 `规范名 → 实际名`。
- **可靠性守卫**（任一不成立即返回 null）：
  1. `规范名 → 实际名` 单射（同一规范名不得映射到两个不同实际名）；
  2. 两个不同规范名不得撞同一实际名；规范名映射回自身时出现次数须与模板一致。

守卫不成立时宁可不打，与现有 `namesCollide` 同一保守取向。

### 2. 六个靶点的重锚方案

规范模板（`*_CANON`）继续以 1.0.411 压缩名书写，**不改字面量**；只把「查找」换成结构匹配。

| # | 靶点 | 规范模板 | 定位方式 |
| --- | --- | 1 | 选项行 | `ORIG_JS_PATTERN` → `PATCHED_JS_CODE` | `matchMasked(content, ORIG_JS_PATTERN)` |
| 2 | 菜单容器 | `ORIG_MENU_PATTERN` → `PATCHED_MENU_CODE` | `matchMasked(content, ORIG_MENU_PATTERN)` |
| 3 | 选中项 ref | `ORIG_REF_PATTERN` → `PATCHED_REF_CODE` | 先 `matchMasked(content, ORIG_JS_PATTERN)` 锁定选项行，只在该段**前** 400 字符内找 ref（该写法在 bundle 中出现 7 次，必须限定作用域） |
| 4 | 弹层函数 | `ORIG_POPOVER_PATTERN` → `PATCHED_POPOVER_CODE` | `matchMasked(content, ORIG_POPOVER_PATTERN)`；规范模板自带 `function Bde(t){` 头部与 `a(Bde,"ContextUsagePopover");` 尾部，跨度即整函数；函数名 / 警告函数名从映射表读出 |
| 5 | 弹层调用处 | `ORIG_POPOVER_CALL_PATTERN` → `PATCHED_POPOVER_CALL_CODE` | `matchMasked(...)`；规范模板以 1.1.14 真机文本归一化（含 Compiler 包装与尾部 memo 赋值），字面量部分与压缩无关 |
| 6 | 上下文下拉 | `CTX_SEL_FN_TEMPLATE` / `CTX_CALL_PATCHED_TEMPLATE` | 函数：命中唯一标签 `a(<fn>,"EffortSelector");` 后按 `<b>.jsx(<fn>,{disabled:<v>})` 结构正则捕获 jsx 运行时名与 disabled 变量名；调用处：同一 `<fn>` 的 `.jsx(` 调用在标签所在组件内唯一命中 |

靶点 4 不再需要 `findPopoverFactory` 的编号捕获组路径；该函数保留导出
（既有 `tests` / `scripts/check-selector-patch.js` 契约）但改由屏蔽匹配实现。
靶点 5 的旧模板以 1.0.411 局部名书写，需按 1.1.14 真机文本归一化后再用（属性名与字面量不变）。

### 3. 还原路径（对称）

还原必须与打补丁对称，否则停用后清理不干净（1.1.14 上现状即如此）：

- 先做**当前版本精确逆替换**：`content.split(PATCHED_X).join(ORIG_X)`——补丁由我们写入，逐字可用，与压缩名无关。
- 再做**历史变体精确逆替换**（`LEGACY_*`）——维持现状。
- 最后保留锚点兜底 `replaceSpan(...)` / `restoreMarkedSpan(...)`，用于「Kiro 升级后文件里躺着旧版补丁」的场景；
  这些锚点（`a2k-`、`__kiroModelConfigProvider` 等）出厂文件绝不出现，不受压缩影响。
- 弹层继续优先走 `restoreCarriedPopover()`（`/*a2k-orig:<base64>*/` 自带出厂原文），
  该路径与压缩名完全无关，是 1.1.14 上最可靠的还原通道。

### 4. 不变的部分

`planModelSelectorScript` / `planKiroAgentBackend` / `planStyleSheet` 的三态推导
（`applied` / `removed` / `unchanged` / `unavailable`）、`commitPlans` 的提交顺序
（selectorScript → backend → style，全有或全无 + 回滚）、`CARD_CSS` 内容、
后端 `findBackendHook` 结构锚点、`ctxStatus` 判定全部保持不变。
本次只改「锚点怎么找」，不改「找到之后怎么判、怎么写」。

### 5. 报错文案

`syncGroupHeaderStyleUnlocked()` 中 `selectorScript === "unavailable"` 分支的 detail 改为指向
真实成因（Kiro 重新压缩了 webview bundle），不再提「目录不可写 / 重装 Kiro」。

## Testing Strategy

仓库没有 `tests/`（开源化时移除，见 commit `192b0e3`），因此验证以**真机 copy + 直调内部导出**为准：

- 验证脚本落在 `dev/`（未跟踪目录），不新增测试目录、不改 `package.json` 脚本。
- 用 `tsc` 把 `src` 编到临时目录，注入 `vscode` 与 `log` 桩，把 `vscode.env.appRoot` 指向
  一份**真机 Kiro 1.1.14 的只读副本**（`/tmp` 下），从而在不动真机的前提下跑真实代码路径。
- fixture：`mermaid-GHXKKRXX-pooCyKz9.js`（1.1.14 真机出厂态）、`style.css`、`dist/extension.js`。
- 断言覆盖 P1–P10；P8–P10 用 `syncGroupHeaderStyle` 端到端跑通「开启 → 关闭 → 出厂态再关闭」。
- 真机落地：备份三个靶点原文件后，把同一份同步在 `/Applications/Kiro.app` 上执行一遍并复验。

## Amendments

> 补充修正

### 2026-09-15 · 实现期修正：落地方案以结构正则为准（并记录三处实现期发现的坑）

落地方案与本文档第 2 节的初稿有实质差异，以本节为准。

**定位实现：结构正则，不是 masked indexOf。**
`scanMasked` 把模板编译成 `nonIdent 逐字转义 + 每个标识符独立通配` 的正则
（`(?<![\w$])[A-Za-z_$][\w$]*(?![\w$])`），直接在原文上匹配；命中后再逐 token 复验并产出改名映射。

做 this 而不是 masked indexOf 的原因（三处都是实现期才暴露的坑）：

1. **掩码等价太弱。** 标识符全被吃掉后模板只剩零星标点与属性名，两段无关代码也可能
   长度相同且屏蔽后相同——实测 KaTeX 符号表里就能撞上选项行的屏蔽串（命中数从 1 变 2）。
2. **掩码串偏移不能当原文偏移。** 标识符被压成单字符，屏蔽串比原文短
   （1.1.14 的 mermaid bundle：1 843 793 → 981 285），拿屏蔽串下标去切原文必然错位。
   结构正则的匹配偏移**就是**原文偏移，直接可用。
3. **同名反引用（既有 `templateRegex` 的做法）会整段失配。** 它要求「模板里两处同名 ⇒ 真机里也两处同名」，
   Kiro 一旦把两个同名变量压成不同名就全灭。所以这里一律**独立通配**，名字改从逐 token 映射里读；
   既有的 `templateRegex`（编号捕获组）及其类型 / 缓存随之删除。

**模板串 / 字符串 / 注释必须整段跳过。**
标识符切分前要先把 `'…'` / `"…"` / `` `…` `` / `//…` / `/*…*/` 整段识别出来当作「非标识符 token」。
否则补丁模板里的 `` `${g}%` `` 反引号会被 `IDENT_RE` 选中（反引号不在 `[\w$]` 里，
`(?<![\w$])` 放行），渲染时被替换成正则占位符，产出 `` v2{g}% `` 这种直接语法错误。
`renderTemplate` 现已委托给 `renderIdentifierMap`（token 流替换），不再用裸 `IDENT_RE`。

**弹层规范串尾部多带一段函数体之外的标签。**
`ORIG_POPOVER_PATTERN` 把「整函数 + 紧随其后的 `a(<fn>,"ContextUsagePopover");`」写成一串；
函数体本身与真机是 1:1 同名改写，但加上那 29 字符标签后 token 数就对不上（421 vs 418）。
故 `findPopoverFactory` 搜索时摘掉标签（`POPOVER_FACTORY_BODY_CANON`），命中后再按真机函数名把标签渲染回来。

**补丁模板自带局部名会与真机压缩名撞车。**
1.1.14 把弹层包装变量压成 `q`、选项行 name 变量压成 `w`、rate 变量压成 `I`、尾部局部压成 `H`，
而补丁模板里本来就有自己的 `w` / `I` / `$` 等局部名。此前 `renderMatched` 的两个守卫
（「两个规范名撞同一实际名」反向单射、`namesCollide`）都会在这些**合法**改名上误拒。
最终规则：**新名字若已被模板自己声明为局部名就放弃该条改名**（`isDeclaredName`，先剥字符串再判），
规范名本身声明在模板里不算冲突（`function <fn>(t){` 那种头部是补丁签名，本来就得换）。
同时把模板自身的 `w` / `I` / `$` 改成 `v0` / `v1` / `v2` 这类不会与压缩名撞车的名字。

**弹层调用处的补丁 = 命中文本 + `,a2kUsage:<store>}`，不是模板渲染。**
`PATCHED_POPOVER_CALL_CODE` 以 1.0.411 的 `Y=g&&` 开头，直接渲染会把真机的包装变量名写错
（1.1.14 实测是 `q=g&&`）。还原同理：用结构正则 `<jsx>.jsx(<fn>,{…livePercentage:…,a2kUsage:<v>})`
去掉该参数，逐字保留真机名，不经过任何规范串。

**靶点命中不再等于 `includes`。** `applySelectorScript` 的三处选择器靶点各自 `matchMasked` + `renderMatched`，
任一为 null 即整文件返回原文（全有或全无不变）；ref 仍限定在「选项行起点之前 2000 字符」窗口内唯一命中，
且还原时窗口基准必须在**还原选项行之前**量取（选项行变短后起点前移，先后次序弄反会漏还原 ref）。
