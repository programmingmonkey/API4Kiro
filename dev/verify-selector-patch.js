#!/usr/bin/env node
/**
 * API4Kiro 选择器补丁：结构锚定验证脚本（4.13.59）
 *
 * 背景：Kiro 1.1.14 把 webview bundle 整体重新压缩，1.0.411 / 1.0.437 压缩名写死的锚点全数失配，
 * 选择器补丁静默不生效（控制面板报 "model selector target not found in mermaid-*.js"）。
 * 修复方式：靶点定位改成「非标识符逐字 + 标识符各自通配」的结构匹配（见 src/selectorStyle.ts）。
 *
 * 本脚本把编译产物跑在**真机 Kiro 1.1.14 的只读副本**上，验证：
 *   P1 跨压缩名等价   P2 唯一命中   P3 映射守卫   P4 不误伤
 *   P5 幂等           P6 往返复原   P7 历史变体   P8/P9/P10 端到端
 *
 * 用法：
 *   node dev/verify-selector-patch.js            # 用真机 Kiro 安装目录做只读副本
 *   node dev/verify-selector-patch.js <appRoot>  # 指定 Kiro appRoot
 *
 * 绝不改动真机文件：所有读写都在 /tmp 下的副本里。
 */
"use strict";
const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFileSync } = require("child_process");

const REPO = path.resolve(__dirname, "..");
const SRC = path.join(REPO, "src");
const REAL_ROOT = process.argv[2] || "/Applications/Kiro.app/Contents/Resources/app";
const WORK = fs.mkdtempSync(path.join(os.tmpdir(), "a2k-verify-"));
const BUILD = path.join(WORK, "build");
const ROOT = path.join(WORK, "root");

let pass = 0;
let fail = 0;
const check = (name, ok, extra) => {
  if (ok) {
    pass++;
    console.log(`  PASS  ${name}`);
  } else {
    fail++;
    console.log(`  FAIL  ${name}${extra === undefined ? "" : `\n        ${extra}`}`);
  }
};
const section = (t) => console.log(`\n== ${t}`);

// ---------------------------------------------------------------- build + fixture
function build() {
  execFileSync(path.join(REPO, "node_modules/.bin/tsc"), ["-p", path.join(REPO, "tsconfig.json"), "--outDir", BUILD, "--noEmit", "false", "--sourceMap", "false"], { stdio: "pipe" });
  const stubDir = path.join(BUILD, "node_modules/vscode");
  fs.mkdirSync(stubDir, { recursive: true });
  fs.writeFileSync(path.join(stubDir, "package.json"), JSON.stringify({ name: "vscode", version: "0.0.0", main: "index.js" }));
  fs.writeFileSync(
    path.join(stubDir, "index.js"),
    `module.exports={env:{appRoot:process.env.A2K_APP_ROOT,appName:"Kiro"},` +
      `workspace:{getConfiguration:()=>({get:()=>undefined})},` +
      `window:{createOutputChannel:()=>({appendLine(){},append(){},show(){},dispose(){}})},` +
      `Uri:{file:(p)=>({fsPath:p,toString:()=>String(p)})},commands:{executeCommand:async()=>undefined}};\n`
  );
  fs.writeFileSync(
    path.join(BUILD, "log.js"),
    `module.exports={info(...a){const t=a.map((x)=>typeof x==="string"?x:JSON.stringify(x)).join(" ");` +
      `(globalThis.__a2kInfo||(globalThis.__a2kInfo=[])).push(t);},debug(){},warn(){},error(){},showLog(){},initLog(){return{appendLine(){},dispose(){}}},` +
      `redactText:(s)=>s,maskSecretForLog:(s)=>s,maskKey:(s)=>s,MAX_LINE_BYTES:65536};\n`
  );
}

/**
 * 把真机上**所有**承载模型选择器 chunk 的 package 都复制进沙箱。
 *
 * Kiro 1.1.14 起聊天界面被拆到 `kiro-ui-session-details`，同一个 chunk（同名 base、不同 hash）
 * 在各 package 下各有一份、各自独立压缩。只复制 kiro-ui-agent-chat 会漏掉用户真正看到的那个视图
 * （2026-09-15 实拍：卡片样式打在 agent-chat，界面却由 session-details 的工厂 chunk 渲染，
 * 于是每行模型名下面直接显示 `__A2K_MDL__|…` 微格式）。
 */
function fixture() {
  const ext = path.join(REAL_ROOT, "extensions/kiro.kiro-agent");
  const chat = path.join(ext, "packages/kiro-ui-agent-chat/dist");
  if (!fs.existsSync(chat)) throw new Error(`not a Kiro appRoot: ${REAL_ROOT}`);
  const pkgsDir = path.join(ROOT, "extensions/kiro.kiro-agent/packages");
  const packages = [];
  for (const pkg of fs.readdirSync(path.join(ext, "packages"))) {
    const dist = path.join(ext, "packages", pkg, "dist");
    const assetsSrc = path.join(dist, "assets");
    if (!fs.existsSync(assetsSrc) || !fs.existsSync(path.join(dist, "style.css"))) continue;
    const chunks = fs.readdirSync(assetsSrc).filter((f) => f.startsWith("mermaid-") && f.endsWith(".js"));
    const carries = chunks.find((f) => fs.readFileSync(path.join(assetsSrc, f), "utf8").includes("chat-input-popup-option"));
    if (!carries) continue;
    const assetsDst = path.join(pkgsDir, pkg, "dist/assets");
    fs.mkdirSync(assetsDst, { recursive: true });
    fs.copyFileSync(path.join(dist, "style.css"), path.join(pkgsDir, pkg, "dist/style.css"));
    for (const f of chunks) fs.copyFileSync(path.join(assetsSrc, f), path.join(assetsDst, f));
    packages.push({ pkg, assets: assetsDst, chunk: path.join(assetsDst, carries), style: path.join(pkgsDir, pkg, "dist/style.css") });
  }
  fs.mkdirSync(path.join(ROOT, "extensions/kiro.kiro-agent/dist"), { recursive: true });
  fs.copyFileSync(path.join(ext, "dist/extension.js"), path.join(ROOT, "extensions/kiro.kiro-agent/dist/extension.js"));
  const chatPkg = packages.find((p) => p.pkg === "kiro-ui-agent-chat") || packages[0];
  return { packages, assets: chatPkg.assets, style: chatPkg.style };
}

// ---------------------------------------------------------------- checks
function main() {
  build();
  const fx = fixture();
  process.env.A2K_APP_ROOT = ROOT;
  const S = require(path.join(BUILD, "selectorStyle.js"));
  const I = S.__selectorStyleInternals;
  const M = I.matchers;
  const P = I.patterns;
  const read = (p) => fs.readFileSync(p, "utf8");
  // 真机可能正运行着上一版 API4Kiro，先只在 /tmp 副本中剥掉注入，得到稳定的出厂 fixture。
  // 这样验证脚本不会把“真机当前是否已打补丁”误当成产品行为。每个 package 的 chunk 都归一。
  for (const pk of fx.packages) {
    pk.factoryChunk = M.restoreSelectorScript(read(pk.chunk));
    fs.writeFileSync(pk.chunk, pk.factoryChunk, "utf8");
    // style.css 同样要归一：真机上可能正带着上一版注入的 CARD_CSS（agent-chat 实测 a2k- 有 70 处）
    fs.writeFileSync(pk.style, M.stripBlock(read(pk.style)), "utf8");
    pk.factoryStyle = read(pk.style);
  }
  const chatPkg = fx.packages.find((p) => p.pkg === "kiro-ui-agent-chat") || fx.packages[0];
  const mermaidFile = chatPkg.chunk;
  const factoryMermaid = chatPkg.factoryChunk;
  const factoryStyle = chatPkg.factoryStyle;

  section("P1 跨压缩名等价：六处靶点全部结构命中（真机 1.1.14 factory 文本）");
  check("fixture 已归一为未打补丁的 factory 文本", !factoryMermaid.includes("a2k-"), "restore 后 mermaid 仍含 a2k-");
  const pairs = [
    ["选项行", P.ORIG_JS_PATTERN],
    ["菜单容器", P.ORIG_MENU_PATTERN],
    ["弹层调用处", P.ORIG_POPOVER_CALL_PATTERN],
  ];
  for (const [label, canon] of pairs) {
    const hits = M.scanMasked(factoryMermaid, canon);
    check(`${label} 结构命中 1 次`, hits.length === 1, `实际 ${hits.length} 次`);
  }
  const fac = M.findPopoverFactory(factoryMermaid);
  check("弹层函数命中且读出真机名", !!fac && fac.names.fn === "n2e" && fac.names.warn === "t2e", fac ? JSON.stringify(fac.names) : "null");
  const eff = M.findEffortSelector(factoryMermaid);
  const effCall = eff ? M.findEffortSelectorCall(factoryMermaid, eff.fn) : null;
  check("EffortSelector 调用处命中", !!effCall, eff ? `fn=${eff.fn}` : "tag not found");

  section("P1b 每个承载模型选择器的 package 都必须能结构命中（它们各自独立压缩）");
  for (const pk of fx.packages) {
    const cur = M.scanMasked(pk.factoryChunk, P.ORIG_JS_PATTERN);
    check(`${pk.pkg} 选项行结构命中 1 次`, cur.length === 1, `实际 ${cur.length} 次`);
    check(`${pk.pkg} 菜单容器命中`, !!M.matchMasked(pk.factoryChunk, P.ORIG_MENU_PATTERN), "null");
  }
  // 选项行 + 菜单容器是「模型列表不再直接显示 __A2K_ 微格式」的充分条件，每个 package 都必须命中（上面）。
  // 弹层是可选组，按「宁可不打」处理结构差异：session-details 这一版把它重构成了
  // `children:[header,breakdown]` 两个记忆化元素（与压缩名无关的真结构差异），因此跳过，
  // 该视图的 Context Usage 保持 Kiro 原生外观。这里只要求至少一个 package 能命中，并把实际命中面打出来。
  const popoverPkgs = fx.packages.filter((pk) => M.findPopoverFactory(pk.factoryChunk)).map((pk) => pk.pkg);
  check("P1b 至少一个 package 的弹层函数可命中", popoverPkgs.length > 0, "全部失配");
  console.log(`      · 弹层命中：${popoverPkgs.join(", ") || "无"}${popoverPkgs.length < fx.packages.length ? `；未命中（结构不同，跳过）：${fx.packages.map((p) => p.pkg).filter((n) => !popoverPkgs.includes(n)).join(", ")}` : ""}`);

  section("P2 唯一命中：通用形态不得被当成靶点");
  check("ORIG_REF_PATTERN 全文出现多处（>1）", M.scanMasked(factoryMermaid, P.ORIG_REF_PATTERN).length > 1, "应当是多处通用形态");
  check("matchMasked 对多命中返回 null", M.matchMasked(factoryMermaid, P.ORIG_REF_PATTERN) === null);

  section("P3 映射守卫：不一致改名必须被拒");
  {
    const canon = "function Bde(t){return t.a+t.b}";
    const tampered = "function n2e(t){return t.a+T.b}"; // 同一个 `t` 被写成两个不同名字
    const fake = factoryMermaid + tampered;
    const hits = M.scanMasked(fake, canon);
    check("不一致改名不产生命中", hits.length === 0, `实际 ${hits.length} 次`);
  }

  section("P4/P8 开启：三靶点 applied 且 a2k- 只来自补丁常量");
  let result;
  (async () => {
    result = await S.syncGroupHeaderStyle(true);
    const patched = read(mermaidFile);
    check("P8 status=applied", result.status === "applied", JSON.stringify(result));
    check("P8 selectorScript/style 均 applied", result.targets.selectorScript === "applied" && result.targets.style === "applied", JSON.stringify(result.targets));
    check("P8 无 detail", !result.detail, result.detail);
    check("P8 补齐条件达成（selectorScript 不是 unavailable）", result.targets.selectorScript !== "unavailable");
    check("P4 mermaid 已改写", patched !== factoryMermaid);
    check("P4 模板插值未退化成 v2{...} 字面量", !/v2\{[^}]+\}/.test(patched), (patched.match(/v2\{[^}]+\}/g) || []).join(" "));
    // 不误伤：把补丁写入的每个 a2k- token 都必须在我们的常量集合里
    // a2k-orig 来自弹层的「随身携带出厂原文」标记；a2k-ctx 来自上下文挡位补丁的定界注释
    const consts = [
      I.patterns.PATCHED_JS_CODE,
      I.patterns.PATCHED_MENU_CODE,
      I.patterns.PATCHED_REF_CODE,
      I.patterns.PATCHED_POPOVER_CODE,
      I.patterns.PATCHED_POPOVER_CALL_CODE,
      I.patterns.CTX_SEL_FN_TEMPLATE,
      I.patterns.CTX_CALL_PATCHED_TEMPLATE,
      I.patterns.CTX_HOST_HOOK_TEMPLATE,
      "/*a2k-orig:*/",
    ].join("\n");
    const known = new Set([...consts.matchAll(/a2k-[A-Za-z0-9_-]+/g)].map((m) => m[0]));
    const seen = new Set([...patched.matchAll(/a2k-[A-Za-z0-9_-]+/g)].map((m) => m[0]));
    const unknown = [...seen].filter((t) => !known.has(t));
    check("P4 所有 a2k- 均来自补丁常量", unknown.length === 0, `未知: ${unknown.join(" ")}`);

    section("P13 多 package：每一份 chunk 与它自己那份 style.css 都要覆盖到");
    for (const pk of fx.packages) {
      check(`P13 ${pk.pkg} chunk 已打补丁`, read(pk.chunk).includes("a2k-model-name-box"), "仍是工厂态（该视图会直接显示 __A2K_ 微格式）");
      check(`P13 ${pk.pkg} style.css 上了 CARD_CSS`, read(pk.style).includes("a2k-model-row"), "该 package 的 style.css 没有 a2k CSS");
    }

    section("P14 落地守卫：模板里的单参调用 (X) 不是参数声明");
    {
      // 规范名 k 在真机被压成 T；真机里 b 又正好压成 k。
      // 旧判据 [(,]NAME[,)] 会把模板里的单参调用 q(T) 当成「模板声明了 T」，
      // 于是丢掉 k->T 这条改名；k 因此落进 namesCollide 的 others，与 b->k 撞车 → 整条补丁被拒。
      const canonical = "function A(b,k){return q(T)}";
      const content = "function A(k,T){return q(m)}";
      const template = "function A(b){return q(T)+k.x}";
      const span = M.matchMasked(content, canonical);
      check("P14 单参调用不得导致整条改名被拒", !!span && M.renderMatched(template, canonical, span) !== null, "守卫仍把 (X) 误判成参数声明");
    }
    for (const pk of fx.packages) {
      const span = M.matchMasked(pk.factoryChunk, P.ORIG_JS_PATTERN);
      check(
        `P14 ${pk.pkg} 选项行补丁可渲染`,
        !!span && M.renderMatched(P.PATCHED_JS_CODE, P.ORIG_JS_PATTERN, span) !== null,
        "该视图会直接显示 __A2K_ 微格式"
      );
    }

    section("P11 重复同步（等同重载窗口后再激活）：不得误报 unavailable、不得把 CSS 剥掉");
    {
      // 第二次开启时磁盘上已是「渲染过的补丁」（标识符是真机压缩名），不是规范模板。
      // 状态判定必须认出补丁已在位，否则会被当成「靶点不命中」，进而让 styleEnabled=false 把 CARD_CSS 剥掉。
      const st = read(fx.style);
      const mm = read(mermaidFile);
      check("P11 前置：style.css 带 a2k CSS", st.includes("a2k-model-row"), "第一次开启后 CSS 就不在");
      check("P11 前置：mermaid 带补丁", mm.includes("a2k-model-name-box"));
      const second = await S.syncGroupHeaderStyle(true);
      check("P11 第二次开启不报 unavailable", second.targets.selectorScript !== "unavailable", JSON.stringify(second.targets));
      check("P11 第二次开启后 style.css 仍有 a2k CSS", read(fx.style).includes("a2k-model-row"), "CSS 被剥掉了（模型卡片失去样式）");
      check("P11 第二次开启后 mermaid 仍有补丁", read(mermaidFile).includes("a2k-model-name-box"), "JS 补丁被抹掉了");
    }

    section("P9 关闭：还原到与 factory 逐字一致");
    const off = await S.syncGroupHeaderStyle(false);
    check("P9 status=removed", off.status === "removed", JSON.stringify(off));
    check("P9 mermaid 与 factory 逐字一致", read(mermaidFile) === factoryMermaid);
    check("P9 style 与 factory 逐字一致", read(fx.style) === factoryStyle);
    for (const pk of fx.packages) {
      check(`P9 ${pk.pkg} chunk 还原为 factory`, read(pk.chunk) === pk.factoryChunk);
      check(`P9 ${pk.pkg} style.css 还原为 factory`, read(pk.style) === pk.factoryStyle);
    }

    section("P5/P6 幂等与往返");
    const before = read(mermaidFile);
    await S.syncGroupHeaderStyle(false);
    check("P5 restore 幂等（再次关闭不改动文件）", read(mermaidFile) === before);
    const onceRestored = read(mermaidFile);
    await S.syncGroupHeaderStyle(true);
    const p1 = read(mermaidFile);
    await S.syncGroupHeaderStyle(false);
    check("P6 restore(apply(factory)) === factory", read(mermaidFile) === factoryMermaid && onceRestored === factoryMermaid);
    await S.syncGroupHeaderStyle(true);
    await S.syncGroupHeaderStyle(true);
    check("P5 apply 幂等（连开两次不再变更）", read(mermaidFile) === p1);
    await S.syncGroupHeaderStyle(false);

    section("P10 factory 态空转");
    const idle = await S.syncGroupHeaderStyle(false);
    check("P10 status=unchanged", idle.status === "unchanged", JSON.stringify(idle));

    section("P7 历史变体：1.0.411 形态的孤儿补丁仍能清掉");
    {
      const legacyRef = 'ref:a(O=>{m.current[x]=O;if(O&&C&&!O.dataset.a2kScrolled){O.dataset.a2kScrolled="1";setTimeout(()=>{O.scrollIntoView({block:"center",behavior:"instant"});},10);}},"ref")';
      const legacyMenu = 'className:"chat-input-popup-menu a2k-model-selector-menu"';
      let txt = factoryMermaid.replace(P.ORIG_REF_PATTERN, legacyRef).replace('className:"chat-input-popup-menu"', legacyMenu);
      const restored = I.matchers.restoreSelectorScript(txt);
      check("P7 旧版 ref 孤儿被清掉", !restored.includes("a2kScrolled"));
      check("P7 旧版菜单类被清掉", !restored.includes("a2k-model-selector-menu"));
    }

    section("P12 判定诚实：靶点不命中而剥掉 CSS 时，日志不得声称 applied");
    {
      globalThis.__a2kInfo = [];
      await S.syncGroupHeaderStyle(true);
      check("P12 前置：CSS 在位", read(fx.style).includes("a2k-model-row"), "前置状态不对");
      // 构造「出厂结构被改写、靶点确实不该打」的真机形态：先归一出厂，再改掉选项行的结构锚。
      // 每个 package 都要破坏——只要还有一份带补丁，patchedPresent 就为真，整体会被判成 unchanged。
      for (const pk of fx.packages) {
        const broken = I.matchers.restoreSelectorScript(read(pk.chunk)).split('"chat-input-popup-option"').join('"chat-input-popup-option-broken"');
        fs.writeFileSync(pk.chunk, broken, "utf8");
      }
      globalThis.__a2kInfo = [];
      const res = await S.syncGroupHeaderStyle(true);
      const styleLines = (globalThis.__a2kInfo || []).filter((l) => String(l).includes("style.css"));
      const styleLine = styleLines.join(" | ");
      check("P12 靶点不命中 → selectorScript unavailable", res.targets.selectorScript === "unavailable", JSON.stringify(res.targets));
      check("P12 CSS 确被剥掉", !read(fx.style).includes("a2k-model-row"), "CSS 还在，场景没构造成功");
      check("P12 日志不得声称 applied card model selector style", !styleLines.some((l) => String(l).includes("applied card model selector style")), styleLine);
      check("P12 日志应记为 restored original Kiro style", styleLines.some((l) => String(l).includes("restored original Kiro style")), styleLine);
      // 复原现场
      for (const pk of fx.packages) fs.writeFileSync(pk.chunk, pk.factoryChunk, "utf8");
      await S.syncGroupHeaderStyle(false);
    }

    console.log(`\n${pass} passed, ${fail} failed  (workdir ${WORK})`);
    process.exitCode = fail ? 1 : 0;
  })().catch((e) => {
    console.error("\nverification crashed:", e);
    process.exitCode = 1;
  });
}

main();
