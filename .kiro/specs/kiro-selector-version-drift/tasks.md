# Implementation Plan: 选择器补丁靶点结构化重锚

## Overview

把 `src/selectorStyle.ts` 里六个 mermaid 靶点的定位方式从「逐字匹配 1.0.411 / 1.0.437 压缩名」
换成标识符屏蔽结构匹配，使补丁在 Kiro 重新压缩 webview bundle 后仍能命中，
并保持既有的三态分类、「全有或全无」、提交顺序与还原语义不变。

分四段：匹配器内核 → 六靶点改造 → 文案与导出 → Properties 1–10 验证与真机落地。

## Tasks

- [x] 1. 标识符屏蔽匹配器（`src/selectorStyle.ts`）
  - [x] 1.1 实现 `mask()`：`/(?<![\w$])[A-Za-z_$][\w$]*/g` → 单字符哨兵 `U+0000`，保证屏蔽后长度不变
  - [x] 1.2 实现 `scanMasked()` / `matchMasked()`：屏蔽模板与内容后按 `indexOf` 扫全部命中，唯一命中才返回
  - [x] 1.3 实现 `renderMatched()`：按位置 zip 导出「规范名 → 实际名」映射，加单射 + 无撞名守卫，不可靠返回 `null`
  - [x] 1.4 把 `scanMasked` / `matchMasked` / `renderMatched` / `mask` 挂到 `__selectorStyleInternals.matchers`，供验证脚本调用
- [x] 2. 选择器三处靶点换成屏蔽匹配
  - [x] 2.1 选项行：`applySelectorScript` 用 `matchMasked(content, ORIG_JS_PATTERN)` + `renderMatched(PATCHED_JS_CODE, …)` 替换 `includes` / `String.replace`
  - [x] 2.2 菜单容器：同上，规范模板 `ORIG_MENU_PATTERN` → `PATCHED_MENU_CODE`
  - [x] 2.3 选中项 ref：以选项行命中段为作用域，只在其前 400 字符内匹配 `ORIG_REF_PATTERN`（该写法全文 7 处），替换为 `PATCHED_REF_CODE`
  - [x] 2.4 三处改为「全部命中才写」：任一 `matchMasked` 或 `renderMatched` 返回 `null` 即整文件返回原文（保持全有或全无）
- [x] 3. 弹层两处靶点换成屏蔽匹配
  - [x] 3.1 以 1.1.14 真机文本归一化 `ORIG_POPOVER_CALL_PATTERN` 与 `PATCHED_POPOVER_CALL_CODE` 的字面量形态（属性名与字面量不变，仅局部名按真机改写）
  - [x] 3.2 `findPopoverFactory` 改由 `matchMasked(content, ORIG_POPOVER_PATTERN)` 实现：整函数跨度一次性给出，函数名 / 警告函数名从映射表读出，保持导出签名不变
  - [x] 3.3 `applyPopover` 用同一命中段的映射渲染 `PATCHED_POPOVER_CODE`，调用处用屏蔽匹配渲染 `PATCHED_POPOVER_CALL_CODE`；任一失败返回 `null`
  - [x] 3.4 保留 `restoreCarriedPopover()` 优先级与 `restoreMarkedSpan()` 兜底不变
- [x] 4. 上下文下拉调用处换结构匹配
  - [x] 4.1 `findEffortSelectorCall`：由「标签名 + `<fn>(<fn>,{disabled:<v>})` 形状」改为「命中唯一标签 `a(<fn>,"EffortSelector");` 后，按 `<b>.jsx(<fn>,{disabled:<v>})` 结构正则捕获 `b` 与 disabled 变量名」
  - [x] 4.2 调用处定位限定在该 `<fn>` 的调用点且要求唯一命中；不唯一即 `applyCtxSelector` 返回 `null`
- [x] 5. 报错文案与导出
  - [x] 5.1 更新 `syncGroupHeaderStyleUnlocked()` 中 `selectorScript === "unavailable"` 的 detail：指向「Kiro 重新压缩了 webview bundle」，不再提目录权限 / 重装 Kiro
  - [x] 5.2 复核 `__selectorStyleInternals` 导出（新增匹配器、归一化后的模板），保证既有消费方契约不被破坏
- [x] 6. Properties 1–7 验证（沙箱，真机 1.1.14 只读副本）
  - [x] 6.1 搭 `dev/` 验证脚本：`tsc` 编到临时目录、注入 `vscode` / `log` 桩、`appRoot` 指向 `/tmp` 下的真机副本
  - [x] 6.2 Property 1–2：六处靶点全部命中且唯一；构造多命中场景断言返回 `null`
  - [x] 6.3 Property 3：构造「同一规范名映射到两名」「两名撞一名」文本，断言 `renderMatched` 返回 `null` 且 `applySelectorScript` 一字不写
  - [x] 6.4 Property 4：断言 `a2k-` 只出现在预期靶点、非靶点区域逐字不变
  - [x] 6.5 Property 5–6：断言 `apply` / `restore` 幂等，且 `restore(apply(x)) === x`
  - [x] 6.6 Property 7：用 1.0.411 / 1.0.437 历史变体文本断言还原到出厂
- [x] 7. Properties 8–10 端到端 + 真机落地
  - [x] 7.1 在沙箱副本上跑 `syncGroupHeaderStyle(true)` → 断言三靶点 `applied`、无 detail（Property 8）
  - [x] 7.2 紧接 `syncGroupHeaderStyle(false)` → 断言 `removed` 且与原文件逐字一致（Property 9）
  - [x] 7.3 出厂态再调 `syncGroupHeaderStyle(false)` → 断言 `unchanged` 且 mtime 不变（Property 10）
  - [x] 7.4 备份 `/Applications/Kiro.app` 三个靶点原文件后，在真机执行开启 → 关闭复验，并回报结果
- [x] 8. 收尾
  - [x] 8.1 `npm run compile` 通过（`tsc --noEmit`）
  - [x] 8.2 `npm run bundle` 重新生成 `dist/extension.js` 并确认产物含新匹配器
  - [x] 8.3 复核 design.md 的「不变的部分」未被触碰：三态分类、提交顺序、全有或全无、回滚、`CARD_CSS`、后端结构锚点

## Task Dependency Graph

```json
{"waves":[{"id":0,"tasks":["1.1","1.2","1.3"]},{"id":1,"tasks":["1.4"]},{"id":2,"tasks":["2.1","2.2","2.3","3.1","4.1"]},{"id":3,"tasks":["2.4","3.2","3.3","3.4","4.2"]},{"id":4,"tasks":["5.1","5.2"]},{"id":5,"tasks":["6.1"]},{"id":6,"tasks":["6.2","6.3","6.4","6.5","6.6"]},{"id":7,"tasks":["7.1","7.2","7.3"]},{"id":8,"tasks":["7.4"]},{"id":9,"tasks":["8.1","8.2","8.3"]}]}
```

## Notes

- 本仓库无 `tests/`（开源化时移除，commit `192b0e3`），验证脚本放 `dev/`（未跟踪），不新增测试目录、不改 `package.json`。
- 真实 fixture：真机 Kiro **1.1.14** 的 `mermaid-GHXKKRXX-pooCyKz9.js` / `style.css` / `dist/extension.js` 只读副本。
- 报错文案里的两条处置动作（目录不可写 / 重装 Kiro）经实测均不成立，任务 5.1 负责修正。
- Kiro 1.1.14 上后端 `findBackendHook` 结构锚点仍命中（`dist/extension.js` 已有 `__kiroModelConfigProvider=t`），本次不动该路径。

### 实现期偏差记录

- **任务 3.1 未按原样执行**：原计划「以 1.1.14 真机文本归一化 `*_POPOVER_CALL_PATTERN` 的字面量」，
  实测该规范串与 1.1.14 **逐字相同**（局部名恰好一致），无需归一化。
  真正出问题的是「用 `PATCHED_POPOVER_CALL_CODE` 模板渲染调用处」——它把真机包装变量 `q` 写成了规范名 `Y`。
  改为「命中文本 + `,a2kUsage:<store>}`」逐字构造。
- **任务 3.2 顺带删除 `templateRegex` 及其类型 / 缓存**：它用「同名反引用」，与本次「标识符各自独立通配」
  的结构匹配重复且更脆。`findPopoverFactory` 改由 `matchMasked` 实现。
- **新增实现约束（原设计未预料）**：标识符切分必须整段跳过字符串 / 模板串 / 注释，
  否则模板里的 `` `${g}%` `` 反引号会被当成标识符替换，产出坏代码。见 design.md 的 amendments。
- **验证入口**：`node dev/verify-selector-patch.js`（24 项断言全绿）；`dev/**` 已加入 `.vscodeignore`。
- 2026-09-15 · DSH · 新增 bugfix spec：Kiro 1.1.14 选择器补丁靶点漂移；src/selectorStyle.ts 六处靶点改为结构等价匹配（非标识符逐字 + 标识符独立通配），还原路径对称改造，新增 dev/verify-selector-patch.js（24 项断言全绿），版本 4.13.58→4.13.59
