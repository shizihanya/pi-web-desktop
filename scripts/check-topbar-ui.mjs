#!/usr/bin/env node
/**
 * 顶部工具栏 / 项目页签栏的静态回归检查（不启动 Electron）。
 *
 * 锁住这次重设计里「不能退化」的结构契约：
 *  - 顶部高度仍为 40px，窗口拖动区只在 .drag-strip 上；
 *  - 功能按钮统一尺寸 / 图标 / 间距，且全部 no-drag；
 *  - Windows WCO 窗口控件用显式安全区占位（env() + 兜底），按钮不侵入；
 *  - 页签标题省略、图标 / 状态 / 关闭按钮都是固定槽位（不引起重排）；
 *  - 单栏与分屏 Pane 共用同一套页签视觉规范；
 *  - 原有分屏 / 拖拽 / 五方向投放的事件绑定全部保留。
 *
 *   npm run check:topbar-ui
 */
import fs from "node:fs";

const html = fs.readFileSync("src/renderer/tabbar/index.html", "utf8");
const css = fs.readFileSync("src/renderer/tabbar/style.css", "utf8");
const ts = fs.readFileSync("src/renderer/tabbar/tabbar.ts", "utf8");
const preload = fs.readFileSync("src/preload/tabbar.ts", "utf8");
const titlebar = fs.readFileSync("src/main/titlebar.ts", "utf8");

let failed = 0;
function check(label, ok, detail = "") {
  console.log(`${ok ? "✓" : "✗"} ${label}${ok || !detail ? "" : ` → ${detail}`}`);
  if (!ok) failed += 1;
}

/* ---- 高度 / 主题 / 拖动区 ---- */
check("顶部栏高度沿用 40px", /--tabbar-height:\s*40px/.test(css));
check(
  "主进程 TITLEBAR_HEIGHT 与 CSS 一致",
  /TITLEBAR_HEIGHT\s*=\s*40/.test(titlebar),
);
check(
  "拖动区只声明在 .drag-strip 上",
  [...css.matchAll(/-webkit-app-region:\s*drag/g)].length >= 1 &&
    [...css.matchAll(/-webkit-app-region:\s*drag/g)].every((m) => {
      const before = css.slice(Math.max(0, m.index - 260), m.index);
      return /\.drag-strip[^{}]*\{[^{}]*$/.test(before);
    }),
);
check("功能按钮 / 工具区显式 no-drag", /\.tool-button\s*\{[^}]*no-drag/s.test(css) && /\.window-tools\s*\{[^}]*no-drag/s.test(css));
check("分屏仅顶部一行的 drag-strip 可拖", /\.pane-tabbar\.is-top\s+\.drag-strip\s*\{[^}]*drag/s.test(css));

/* ---- 功能操作区 ---- */
check("按钮统一 32px 点击区", /--tool-size:\s*32px/.test(css) && /\.tool-button\s*\{[^}]*width:\s*var\(--tool-size\)/s.test(css));
check("图标统一 16px", /--tool-icon-size:\s*16px/.test(css) && /\.tool-button\s+svg\s*\{[^}]*width:\s*var\(--tool-icon-size\)/s.test(css));
check("按钮间统一 4px 间距", /--tool-gap:\s*4px/.test(css));
check("按钮默认透明底、无独立边框", /\.tool-button\s*\{[^}]*background:\s*transparent/s.test(css) && /\.tool-button\s*\{[^}]*border:\s*0/s.test(css));
check("Hover 轻量背景 / Active 克制强调色", /\.tool-button:hover\s*\{[^}]*background:\s*var\(--bg-hover\)/s.test(css) && /\.tool-button\.is-on\s*\{[^}]*color-mix\([^)]*var\(--accent\)/s.test(css));
for (const id of ["split-button", "draft-toggle", "new-tab", "open-settings"]) {
  check(`保留功能按钮 #${id}`, new RegExp(`id="${id}"`).test(html));
}
check("四个按钮归入 .tool-actions 组", /<div class="tool-actions">[\s\S]*?id="open-settings"[\s\S]*?<\/div>/.test(html));
check("分屏/独立输入/新建/设置的事件绑定未变",
  /newTabButton\.addEventListener\("click"/.test(ts) &&
  /settingsButton\.addEventListener\("click"/.test(ts) &&
  /splitButton\.addEventListener\("click"/.test(ts) &&
  /showSplitMenu\(/.test(ts) &&
  /piWebDrafts\.toggle\(\)/.test(fs.readFileSync("src/renderer/tabbar/draft-panel.ts", "utf8")));

/* ---- 服务状态 / 窗口控件 ---- */
check("服务状态是独立胶囊", /\.status\s*\{[^}]*border-radius:\s*var\(--radius-pill\)/s.test(css));
check("状态点四态（运行/复用/异常/启动中）", /\.dot\.ok/.test(css) && /\.dot\.warn/.test(css) && /\.dot\.err/.test(css) && /\.dot\.pending/.test(css));
check("端口与次要信息分开展示", /id="status-text"/.test(html) && /id="status-extra"/.test(html) && /statusExtra\.textContent/.test(ts));
check("状态数据仍来自 ServerState", /onServerState\(renderStatus\)/.test(ts) && /getServerState\(\)/.test(ts));
check("WCO 安全区用 env() + 140px 兜底", /--wco-safe-width:[\s\S]*?env\(titlebar-area-x[\s\S]*?140px/.test(css));
check("窗口控件是显式独立区域", /class="window-controls"/.test(html) && /:root\[data-titlebar="overlay"\]\s+\.window-controls\s*\{[^}]*width:\s*var\(--wco-safe-width\)/s.test(css));
check("原生标题栏模式下不预留安全区", /\.window-controls\s*\{[^}]*display:\s*none/s.test(css));
check("未改动 preload / IPC 通道", /contextBridge\.exposeInMainWorld\("piWebTabs", api\)/.test(preload) && !/window:(minimize|maximize|close)/.test(preload));

/* ---- 项目页签 ---- */
check("单栏与分屏 Pane 共用基础规范", /\.tabbar,\s*\.pane-tabbar\s*\{/s.test(css));
check("活动页签有背景层次 + 底部强调线", /\.tab\.active\s*\{[^}]*color-mix/s.test(css) && /\.tab\.active::after\s*\{[^}]*background:\s*var\(--accent\)/s.test(css));
check("非活动页签透明底 / Hover 轻量背景", /\.tab\s*\{[^}]*background:\s*transparent/s.test(css) && /\.tab:hover\s*\{[^}]*background:\s*var\(--bg-hover\)/s.test(css));
check("长标题单行省略 + 原生 Tooltip", /\.tab-title\s*\{[^}]*text-overflow:\s*ellipsis/s.test(css) && /white-space:\s*nowrap/.test(css) && /el\.title\s*=/.test(ts));
check(
  "标题行高足够容纳 g/p/y 下降部",
  (() => {
    const block = /\.tab-title\s*\{([^}]*)\}/s.exec(css)?.[1] ?? "";
    const lh = /line-height:\s*([\d.]+)\s*;/.exec(block);
    // overflow:hidden 是省略号必需的，行盒压到 1 会把下降部一起裁掉
    return Boolean(lh) && Number(lh[1]) >= 1.3 && !/line-height:\s*1\s*;/.test(block);
  })(),
  "line-height 不能压到 1，否则 g/p/y 下半部会被裁掉",
);
check("图标 / 状态 / 关闭按钮均为固定槽位（不重排）",
  /--tab-icon-size:\s*14px/.test(css) &&
  /--tab-close-size:\s*20px/.test(css) &&
  /\.tab-icon\s*\{[^}]*flex:\s*0 0 var\(--tab-icon-size\)/s.test(css) &&
  /\.spinner\s*\{[^}]*flex:\s*0 0 var\(--tab-icon-size\)/s.test(css) &&
  /\.tab-status\s*\{[^}]*flex:\s*0 0 12px/s.test(css) &&
  /\.tab-close\s*\{[^}]*flex:\s*0 0 var\(--tab-close-size\)/s.test(css));
check("图标 / 标题 / 状态 / 关闭统一垂直居中", /\.tab\s*\{[^}]*align-items:\s*center/s.test(css));
check("关闭按钮 Hover 才显示，活动页签可见", /\.tab:hover\s+\.tab-close,\s*\.tab\.active\s+\.tab-close\s*\{[^}]*opacity/s.test(css));
check("关闭按钮有独立 Hover 底色", /\.tab-close:hover\s*\{[^}]*background:\s*color-mix/s.test(css));
check("页签具备 role=tab / aria-selected / aria-label", /setAttribute\("role", "tab"\)/.test(ts) && /setAttribute\("aria-selected", String\(active\)\)/.test(ts) && /setAttribute\("aria-label", fullTitle\)/.test(ts));
check("固定页签保留原有隐藏规则", /\.tab\.pinned\s+\.tab-title,\s*\.tab\.pinned\s+\.tab-close\s*\{[^}]*display:\s*none/s.test(css));
check("Agent 状态与项目身份视觉分离", /\.tab-status/.test(css) && !/\.tab\[data-project[^\]]*\]\s*\{/.test(css) && !/projectColor|project-color/.test(css + ts));
check("焦点 / 非焦点 Pane 的 Tab 有适度差异", /\.pane-tabbar:not\(\.is-focused\)\s+\.tab\.active/.test(css) && /\.pane-tabbar\.is-focused/.test(css));
check("窄窗口压缩页签、隐藏次要文字", /@media \(max-width:\s*1120px\)/.test(css) && /\.status-extra\s*\{\s*display:\s*none/.test(css));

/* ---- 拖拽 / 分屏逻辑不变 ---- */
check("单栏拖动排序仍绑定 tabbar", /tabbar\.addEventListener\("dragover"/.test(ts) && /tabbar\.addEventListener\("drop"/.test(ts) && /insertionIndexFor\(/.test(ts));
check("五方向投放 + 主进程预览仍保留", /previewTabDrop\(/.test(ts) && /dropTab\(/.test(ts) && /beginTabDrag\(/.test(ts) && /endTabDrag\(/.test(ts));
check("drop 命中区高亮 / 预览矩形仍保留", /highlightRegion\(/.test(ts) && /renderDropPreview\(/.test(ts) && /drop-before/.test(css));
check("分隔条按 id 复用、pointer capture 不变", /sashEls\.get\(/.test(ts) && /setPointerCapture\(/.test(ts));
check("每 Pane 自己的 + 按钮保留", /newTabInGroup\(index\)/.test(ts) && /pane-new-tab/.test(ts));

console.log(failed ? `\n顶部栏 UI 检查失败：${failed} 项` : "\n顶部栏 UI 检查通过");
process.exit(failed ? 1 : 0);
