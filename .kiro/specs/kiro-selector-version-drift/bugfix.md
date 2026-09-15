# Bugfix: Kiro 1.1.14 选择器补丁靶点漂移

## Introduction

在 Kiro **1.1.14**（`distro d0fd3324a737f695bd14f2aee3ca92accd28870f`）上，API4Kiro 4.13.58 的
选择器补丁同步失败，控制面板报错：

```
API4Kiro 未能同步 Kiro 选择器补丁（model selector target not found in mermaid-*.js
(Kiro version drift); style not applied）。关闭代理或停用插件后请检查 Kiro 安装目录是否可写；
重装 / 更新 Kiro 会恢复出厂文件。
```

报错文案把成因归到「目录不可写 / 需要重装 Kiro」，实测**两者都不是成因**：
`/Applications/Kiro.app/Contents/Resources/app/extensions/kiro.kiro-agent/packages/kiro-ui-agent-chat/dist/assets/`
对当前用户可写（create/delete 均成功），且 `codesign --verify /Applications/Kiro.app` 早已返回
`a sealed resource is missing or invalid`（上一次 `dist/extension.js` 写入所致）。

真实成因：`src/selectorStyle.ts` 的靶点锚定串以 Kiro **1.0.411 / 1.0.437** 的压缩名为基准书写，
而 1.1.14 重新压缩了整个 webview bundle。实测（对真机 bundle 只读副本运行 `__selectorStyleInternals`）：

| 靶点 | 锚定串 | 真机命中 |
| --- | --- | --- |
| 选项行 | `ORIG_JS_PATTERN` | 否 |
| 菜单容器 | `ORIG_MENU_PATTERN` | 否 |
| 选中项 ref | `ORIG_REF_PATTERN` | 否 |
| 触发器 | `ORIG_TRIGGER_PATTERN` | 是 |
| 弹层函数 | `ORIG_POPOVER_PATTERN` / `findPopoverFactory` | 否 / `null` |
| 弹层调用处 | `ORIG_POPOVER_CALL_PATTERN` | 否 |
| 上下文下拉调用处 | `findEffortSelectorCall` | 否 |

`applySelectorScript()` 要求选项行 / 菜单 / ref 三处**全中**才打补丁，任一处不中即整文件不写，
于是 `selectorScript = "unavailable"`；`syncGroupHeaderStyleUnlocked()` 又用该状态关掉 CSS，
最终浮出上述文案。**一个锚点漂移会连带关掉样式靶点**，用户看到的是「样式没生效」。

新增事实（本 bug 修复的可行基础）：上述六份**规范模板在 1.1.14 里除压缩名外逐字未变**。
把模板与真机文本的所有标识符统一替换为哨兵后逐一比对，六者全部在真机命中，
其中五者命中次数恰为 1（`ORIG_REF_PATTERN` 作为通用写法在 bundle 中出现 7 次，需限定在选项行内定位）。

## Bug Analysis

### Current Behavior (Defect)

- WHEN Kiro 升级到 1.1.14 后扩展执行选择器同步，the system SHALL 因选项行 / 菜单 / ref 三处锚点
  逐字不匹配而放弃写入 `mermaid-*.js`，并把 `selectorScript` 报为 `unavailable`。
- WHEN `selectorScript` 为 `unavailable` 且代理处于开启状态，the system SHALL 同时放弃写入 `style.css`
  （`styleEnabled = enabled && selectorScript.status !== "unavailable"`），因此模型选择器卡片样式不生效。
- WHEN 报错浮到控制面板，the system SHALL 输出把成因指向「Kiro 安装目录不可写 / 重装 Kiro」的文案，
  即使目录可写、且重装只会抹掉仍在生效的后端钩子。
- WHEN 用户在 1.1.14 上关闭代理或停用插件，the system SHALL 因还原路径同样依赖 1.0.411 锚点，
  无法保证把 `a2k-` 注入清理干净。

### Expected Behavior (Correct)

- WHEN Kiro 升级并重新压缩 webview bundle，the system SHALL 仍按结构命中选项行补丁靶点
  （只要出厂表达式结构未变），不因压缩名变化而放弃。
- WHEN 结构锚点命中且无命名冲突，the system SHALL 写入与当前 Kiro 压缩名一致的补丁，
  并使用户看到模型选择器卡片化分组样式。
- WHEN 用户在任意受支持 Kiro 版本上关闭代理或停用插件，the system SHALL 把所有 API4Kiro 注入
  还原为出厂内容，产物与出厂文件逐字一致。
- WHEN 靶点**确实**不再存在（结构本身被 Kiro 改写，而非仅改名），the system SHALL 仍报 `unavailable`
  并且**一字不写**目标文件，保持「全有或全无」语义。
- WHEN 同步失败，the system SHALL 给出的 detail 不再把用户引向「目录不可写 / 重装 Kiro」这类
  与实测不符的处置动作。

### Unchanged Behavior (Regression Prevention)

- the system SHALL CONTINUE TO 保持「全有或全无」：选项行 / 菜单 / ref 三处任一不命中则整文件不写。
- the system SHALL CONTINUE TO 在靶点不命中时不追加 `CARD_CSS`（避免「改了外观却没有对应功能」的半补丁）。
- the system SHALL CONTINUE TO 让后端 `dist/extension.js` 的 `modelConfigProvider` 钩子在 1.1.14 上
  正常工作（`findBackendHook` 走结构锚点，实测已命中）。
- the system SHALL CONTINUE TO 在 `enabled=false` 时尽力还原、每份文件独立上报写失败。
- the system SHALL CONTINUE TO 只改 Kiro 自己的三个靶点文件，不触碰同目录下其他文件；
  过期临时文件只清理本插件命名（`<file>.api4kiro-<pid>.tmp`）且超过 60 s 者。
