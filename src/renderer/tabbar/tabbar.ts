import type {
  DropPreview,
  ServerState,
  TabInfo,
  TabStatus,
  TabsSnapshot,
  ThemeSnapshot,
} from "../../shared/types";
import {
  topRightPaneIndex,
  type DropSide,
  type PaneRect,
  type SplitSnapshot,
} from "../../shared/split";
// 桌面增强：独立输入工作区面板（只往窗口自己的渲染层挂 UI，不改 pi-web 页面）
import "./draft-panel";

const tabsBox = document.getElementById("tabs") as HTMLDivElement;
const tabbar = document.getElementById("tabbar") as HTMLDivElement;
const windowTools = document.getElementById("window-tools") as HTMLDivElement;
const paneLayer = document.getElementById("pane-layer") as HTMLDivElement;
const sashLayer = document.getElementById("sash-layer") as HTMLDivElement;
const dragOverlay = document.getElementById("drag-overlay") as HTMLDivElement;
const dropPreviewLayer = document.getElementById("drop-preview") as HTMLDivElement;
const newTabButton = document.getElementById("new-tab") as HTMLButtonElement;
const settingsButton = document.getElementById("open-settings") as HTMLButtonElement;
const splitButton = document.getElementById("split-button") as HTMLButtonElement;
const status = document.getElementById("status") as HTMLDivElement;
const statusDot = document.getElementById("status-dot") as HTMLSpanElement;
const statusText = document.getElementById("status-text") as HTMLSpanElement;
const statusExtra = document.getElementById("status-extra") as HTMLSpanElement;

let snapshot: TabsSnapshot | null = null;
/** 正在拖动的页签 id */
let dragId: string | null = null;
/** 单栏拖动排序时的插入位置 */
let dropIndex: number | null = null;
/** 分屏拖放模式（内容视图已被主进程临时隐藏） */
let splitDragging = false;
/** 上一次写到 :root 的内联变量，主题切换时先清掉 */
let appliedVars: string[] = [];

/* ---------------- 分隔条拖动（Pointer Events，M2） ----------------
 * 分隔条 DOM 按 SplitNode id 复用：拖动中主进程会持续推 snapshot，
 * 若整层重建会丢掉 pointer capture，所以只增量更新位置。 */
const sashEls = new Map<string, HTMLElement>();
let sashDragging = false;
let sashDragId: string | null = null;
let sashPointerId: number | null = null;
let sashRaf = 0;
let pendingPoint: { x: number; y: number; stamp: number } | null = null;

/* ---------------- 五方向拖放预览（M3） ---------------- */
let dragPreview: DropPreview | null = null;
let previewKey = "";
let previewRaf = 0;
let pendingPreview:
  | { key: string; id: string; paneId: string; side: DropSide; insertIndex?: number }
  | null = null;

/** 页签状态的人话说明（同时也进 hover tooltip / 无障碍标签） */
const STATUS_LABEL: Record<TabStatus, string> = {
  idle: "",
  running: "正在等待回答…",
  unread: "回答完毕，尚未查看",
  awaiting: "等待你的确认",
};

function isSplit(): boolean {
  return (snapshot?.split.groups.length ?? 1) > 1;
}

/**
 * 页签名后的状态指示器。造型照抄 pi-web 侧栏会话列表：
 *  - running：.sidebar-spin 的圆弧 + --accent + 0.9s 匀速旋转
 *  - unread/awaiting：.session-tree-unread 的 6px 实心点 + 扩散光环（蓝/橙）
 */
function createStatus(tab: TabInfo): HTMLElement {
  const el = document.createElement("span");
  el.className = "tab-status";
  el.dataset.status = tab.status;

  if (tab.status === "running") {
    el.innerHTML =
      '<svg class="tab-status-spinner" viewBox="0 0 24 24" fill="none" aria-hidden="true">' +
      '<path d="M21 12a9 9 0 1 1-3.8-7.4" stroke="currentColor" stroke-width="2.8" stroke-linecap="round" />' +
      "</svg>";
  } else if (tab.status === "unread" || tab.status === "awaiting") {
    const dot = document.createElement("span");
    dot.className = `tab-status-dot${tab.status === "awaiting" ? " is-awaiting" : ""}`;
    el.append(dot);
  }

  if (tab.status !== "idle") {
    el.setAttribute("role", "img");
    el.setAttribute("aria-label", STATUS_LABEL[tab.status]);
    el.title = STATUS_LABEL[tab.status];
  }
  return el;
}

function createIcon(tab: TabInfo): HTMLElement {
  if (tab.loading) {
    const spinner = document.createElement("span");
    spinner.className = "spinner";
    return spinner;
  }
  if (tab.favicon) {
    const img = document.createElement("img");
    img.className = "tab-icon";
    img.src = tab.favicon;
    img.alt = "";
    img.onerror = () => {
      img.classList.add("placeholder");
      img.removeAttribute("src");
    };
    return img;
  }
  const dot = document.createElement("span");
  dot.className = "tab-icon placeholder";
  return dot;
}

function createTabElement(tab: TabInfo, active: boolean, index: number): HTMLElement {
  const el = document.createElement("div");
  el.className = "tab";
  // 单栏时没有任何额外标记，和分屏功能加入之前完全一致
  if (active) el.classList.add("active");
  if (tab.pinned) el.classList.add("pinned");
  el.dataset.id = tab.id;
  el.dataset.index = String(index);
  el.draggable = true;
  // 原生 Tooltip 展示完整标题；状态另起一行，不与项目/会话名称混在一起
  const fullTitle = tab.title || "新页签";
  el.title = STATUS_LABEL[tab.status] ? `${fullTitle}\n${STATUS_LABEL[tab.status]}` : fullTitle;

  el.append(createIcon(tab));

  const title = document.createElement("span");
  title.className = "tab-title";
  title.textContent = tab.title || "新页签";
  el.append(title);
  el.append(createStatus(tab));

  // 渲染进程崩溃：页签与会话 URL 都保留，只给一个显式的「重新加载」入口
  if (tab.crashed) {
    el.classList.add("crashed");
    const reload = document.createElement("span");
    reload.className = "tab-crash-reload";
    reload.textContent = "↻";
    reload.title = `页面崩溃（${tab.crashReason ?? "unknown"}）· 点击重新加载`;
    reload.setAttribute("role", "button");
    reload.setAttribute("aria-label", reload.title);
    reload.addEventListener("click", (event) => {
      event.stopPropagation();
      void window.piWebTabs.reloadCrashed(tab.id);
    });
    el.append(reload);
  }

  const close = document.createElement("span");
  close.className = "tab-close";
  close.textContent = "×";
  close.title = "关闭页签 (Ctrl+W)";
  close.setAttribute("role", "button");
  close.setAttribute("aria-label", "关闭页签 (Ctrl+W)");
  close.addEventListener("click", (event) => {
    event.stopPropagation();
    void window.piWebTabs.close(tab.id);
  });
  el.append(close);

  el.addEventListener("click", (event) => {
    if (event.altKey) void window.piWebTabs.splitWith(tab.id);
    else void window.piWebTabs.activate(tab.id);
  });
  el.addEventListener("auxclick", (event) => {
    if (event.button !== 1) return;
    event.preventDefault();
    if (tab.pinned) return;
    void window.piWebTabs.close(tab.id);
  });
  el.addEventListener("contextmenu", (event) => {
    event.preventDefault();
    void window.piWebTabs.showMenu(tab.id, event.clientX, event.clientY);
  });

  el.addEventListener("dragstart", (event) => {
    dragId = tab.id;
    el.classList.add("dragging");
    event.dataTransfer?.setData("text/plain", tab.id);
    if (event.dataTransfer) event.dataTransfer.effectAllowed = "move";
    // 单栏保持原来的「页签栏内拖动排序」；分屏才进入「拖到某个窗格」模式
    if (isSplit()) startSplitDrag();
  });

  return el;
}

function insertionIndexFor(clientX: number): number {
  const elements = [...tabsBox.querySelectorAll<HTMLElement>(".tab")];
  for (const element of elements) {
    const rect = element.getBoundingClientRect();
    if (clientX < rect.left + rect.width / 2) {
      return Number(element.dataset.index ?? 0);
    }
  }
  return elements.length;
}

function applyTheme(theme: ThemeSnapshot, customTitleBar: boolean): void {
  const root = document.documentElement;
  root.dataset.theme = theme.name;
  root.dataset.scheme = theme.scheme;
  root.dataset.titlebar = customTitleBar ? "overlay" : "native";
  root.style.colorScheme = theme.scheme;

  for (const key of appliedVars) root.style.removeProperty(key);
  appliedVars = [];
  if (!theme.fromPage) return;

  for (const [key, value] of Object.entries(theme.vars)) {
    if (!key.startsWith("--") || !value) continue;
    root.style.setProperty(key, value);
    appliedVars.push(key);
  }
}

/* ---------------- 分屏拖动：五方向投放 + 主进程预览（M3） ---------------- */

const REGION_LABEL: Record<DropSide, string> = {
  center: "放到这里（合并页签）",
  left: "← 左侧新建",
  right: "右侧新建 →",
  top: "↑ 上方新建",
  bottom: "↓ 下方新建",
};

/** 五块互不重叠的区域；命中判定与视觉用同一套计算，避免「看到的」和「丢进去的」不一致 */
function dropRegions(
  rect: PaneRect,
): { side: DropSide; x: number; y: number; width: number; height: number }[] {
  const ex = Math.max(24, Math.min(120, rect.width * 0.28));
  const ey = Math.max(24, Math.min(90, rect.height * 0.28));
  const innerW = Math.max(rect.width - ex * 2, 1);
  const innerH = Math.max(rect.height - ey * 2, 1);
  return [
    { side: "left", x: rect.x, y: rect.y, width: ex, height: rect.height },
    { side: "right", x: rect.x + rect.width - ex, y: rect.y, width: ex, height: rect.height },
    { side: "top", x: rect.x + ex, y: rect.y, width: innerW, height: ey },
    { side: "bottom", x: rect.x + ex, y: rect.y + rect.height - ey, width: innerW, height: ey },
    { side: "center", x: rect.x + ex, y: rect.y + ey, width: innerW, height: innerH },
  ];
}

function sideForPoint(rect: PaneRect, clientX: number, clientY: number): DropSide {
  const ex = Math.max(24, Math.min(120, rect.width * 0.28));
  const ey = Math.max(24, Math.min(90, rect.height * 0.28));
  const dx = clientX - rect.x;
  const dy = clientY - rect.y;
  if (dx < ex) return "left";
  if (dx > rect.width - ex) return "right";
  if (dy < ey) return "top";
  if (dy > rect.height - ey) return "bottom";
  return "center";
}

function ghostInsertIndex(zone: HTMLElement, clientX: number): number {
  const ghosts = [...zone.querySelectorAll<HTMLElement>(".drop-ghost")];
  for (let i = 0; i < ghosts.length; i += 1) {
    const rect = ghosts[i].getBoundingClientRect();
    if (clientX < rect.left + rect.width / 2) return i;
  }
  return ghosts.length;
}

function clearHighlights(): void {
  for (const region of dragOverlay.querySelectorAll<HTMLElement>(".drop-region")) {
    region.classList.remove("is-over");
  }
}

function highlightRegion(zone: HTMLElement, side: DropSide): void {
  for (const region of dragOverlay.querySelectorAll<HTMLElement>(".drop-region")) {
    region.classList.toggle(
      "is-over",
      region.parentElement === zone && region.dataset.side === side,
    );
  }
}

/** 主进程算好的「假想拖放后布局」；渲染层只画矩形，不自己算位置 */
function renderDropPreview(): void {
  dropPreviewLayer.replaceChildren();
  if (!dragPreview) return;
  const preview = dragPreview;
  for (const pane of preview.panes) {
    const el = document.createElement("div");
    el.className = "drop-preview-pane";
    if (pane.id === preview.destinationPaneId) {
      el.classList.add("is-destination");
      const label = document.createElement("span");
      label.className = "drop-preview-label";
      label.textContent = preview.createsPane ? "新建窗格" : "拖放后位置";
      el.append(label);
    }
    el.style.left = `${pane.rect.x}px`;
    el.style.top = `${pane.rect.y}px`;
    el.style.width = `${pane.rect.width}px`;
    el.style.height = `${pane.rect.height}px`;
    dropPreviewLayer.append(el);
  }
  if (!preview.allowed && preview.reason) {
    const banner = document.createElement("div");
    banner.className = "drop-reason is-warning";
    banner.textContent = preview.reason;
    dropPreviewLayer.append(banner);
  }
}

/** dragover 高频：rAF 合并 + 参数签名去重；晚到 / 取消后的预览结果一律丢弃 */
function requestDropPreview(
  id: string,
  paneId: string,
  side: DropSide,
  insertIndex?: number,
): void {
  const key = `${id}|${paneId}|${side}|${insertIndex ?? ""}`;
  if (key === previewKey) return;
  previewKey = key;
  pendingPreview = { key, id, paneId, side, insertIndex };
  if (previewRaf) return;
  previewRaf = requestAnimationFrame(() => {
    previewRaf = 0;
    const req = pendingPreview;
    pendingPreview = null;
    if (!req || !splitDragging) return;
    void window.piWebTabs
      .previewTabDrop(req.id, req.paneId, req.side, req.insertIndex)
      .then((preview) => {
        if (!splitDragging || previewKey !== req.key) return;
        dragPreview = preview;
        renderDropPreview();
      })
      .catch(() => {});
  });
}

function createDropZone(
  rect: PaneRect,
  paneId: string,
  title: string,
  ghosts: string[],
  allowedSides: DropSide[],
): HTMLElement {
  const zone = document.createElement("div");
  zone.className = "drop-zone";
  zone.dataset.paneId = paneId;
  zone.style.left = `${rect.x}px`;
  zone.style.top = `${rect.y}px`;
  zone.style.width = `${rect.width}px`;
  zone.style.height = `${rect.height}px`;

  for (const region of dropRegions(rect)) {
    const el = document.createElement("div");
    el.className = `drop-region is-${region.side}`;
    el.dataset.side = region.side;
    el.style.left = `${region.x - rect.x}px`;
    el.style.top = `${region.y - rect.y}px`;
    el.style.width = `${region.width}px`;
    el.style.height = `${region.height}px`;
    const disabled = !allowedSides.includes(region.side);
    if (disabled) el.classList.add("is-disabled");

    const label = document.createElement("span");
    label.className = "drop-region-label";
    label.textContent =
      disabled && region.side !== "center"
        ? `${REGION_LABEL[region.side]}（空间不足或已达 4 格）`
        : region.side === "center"
          ? title
          : REGION_LABEL[region.side];
    el.append(label);

    if (region.side === "center" && ghosts.length > 0) {
      const box = document.createElement("div");
      box.className = "drop-ghosts";
      for (const text of ghosts) {
        const ghost = document.createElement("span");
        ghost.className = "drop-ghost";
        ghost.textContent = text;
        box.append(ghost);
      }
      el.append(box);
    }
    zone.append(el);
  }

  zone.addEventListener("dragover", (event) => {
    event.preventDefault();
    if (event.dataTransfer) event.dataTransfer.dropEffect = "move";
    if (!dragId) return;
    const side = sideForPoint(rect, event.clientX, event.clientY);
    const insertIndex = side === "center" ? ghostInsertIndex(zone, event.clientX) : undefined;
    highlightRegion(zone, side);
    requestDropPreview(dragId, paneId, side, insertIndex);
  });
  zone.addEventListener("drop", (event) => {
    event.preventDefault();
    if (!dragId) return;
    const side = sideForPoint(rect, event.clientX, event.clientY);
    const insertIndex = side === "center" ? ghostInsertIndex(zone, event.clientX) : undefined;
    const id = dragId;
    dragId = null;
    void window.piWebTabs.dropTab(id, paneId, side, insertIndex);
    // 主进程 dropTab 自己会恢复视图；这里只本地收尾，不依赖 dragend
    endSplitDrag(false);
  });
  return zone;
}

function renderDragOverlay(split: SplitSnapshot, current: TabsSnapshot): void {
  dragOverlay.replaceChildren();
  split.groups.forEach((group, index) => {
    const zone = createDropZone(
      split.rects[index],
      split.paneIds[index],
      `窗格 ${index + 1} · 放到这里（合并页签）`,
      group.tabIds.map((id) => current.tabs.find((tab) => tab.id === id)?.title || "新页签"),
      split.dropSides[index] ?? ["center"],
    );
    dragOverlay.append(zone);
  });
}

function hideDragOverlay(): void {
  dragOverlay.hidden = true;
  dragOverlay.replaceChildren();
  dropPreviewLayer.hidden = true;
  dropPreviewLayer.replaceChildren();
  dragPreview = null;
  previewKey = "";
  pendingPreview = null;
  if (previewRaf) {
    cancelAnimationFrame(previewRaf);
    previewRaf = 0;
  }
}

function startSplitDrag(): void {
  if (!snapshot || !isSplit() || splitDragging) return;
  splitDragging = true;
  renderDragOverlay(snapshot.split, snapshot);
  dragOverlay.hidden = false;
  dropPreviewLayer.hidden = false;
  // 主进程临时隐藏所有内容视图，投放层才不会被 WebContentsView 盖住
  void window.piWebTabs.beginTabDrag();
}

/** 收尾；notifyMain=false 表示主进程 dropTab 会自己恢复视图，避免重复 / 竞态 */
function endSplitDrag(notifyMain = true): void {
  if (!splitDragging) return;
  splitDragging = false;
  dragId = null;
  dropIndex = null;
  clearHighlights();
  hideDragOverlay();
  if (notifyMain) void window.piWebTabs.endTabDrag();
  render();
}

/** 统一收尾：pointerup / pointercancel / lostpointercapture / 窗口失焦都走这里 */
function finishSashDrag(): void {
  if (!sashDragging) return;
  sashDragging = false;
  const id = sashDragId;
  sashDragId = null;
  const el = id ? sashEls.get(id) : undefined;
  el?.classList.remove("is-dragging");
  if (sashRaf) {
    cancelAnimationFrame(sashRaf);
    sashRaf = 0;
  }
  pendingPoint = null;
  if (el && sashPointerId !== null) {
    try {
      el.releasePointerCapture(sashPointerId);
    } catch {
      // 指针可能已经被系统释放 / 元素已移除
    }
  }
  sashPointerId = null;
  document.documentElement.classList.remove("sash-dragging", "sash-vertical");
  void window.piWebTabs.endSashDrag();
  render();
}

function bindSash(el: HTMLElement): void {
  el.addEventListener("pointerdown", (event) => {
    if (event.button !== 0) return;
    const splitId = el.dataset.id;
    if (!splitId) return;
    event.preventDefault();
    finishSashDrag(); // 上一次没干净收尾时先复位
    sashDragging = true;
    sashDragId = splitId;
    sashPointerId = event.pointerId;
    el.classList.add("is-dragging");
    document.documentElement.classList.add("sash-dragging");
    if (el.dataset.direction === "vertical") {
      document.documentElement.classList.add("sash-vertical");
    }
    try {
      el.setPointerCapture(event.pointerId);
    } catch {
      // 捕获失败也没关系：主进程会轮询屏幕坐标作为可靠输入源
    }
    void window.piWebTabs.beginSashDrag(splitId);
    void window.piWebTabs.setSashRatio(splitId, event.clientX, event.clientY, Date.now());
  });

  el.addEventListener("pointermove", (event) => {
    if (!sashDragging || el.dataset.id !== sashDragId) return;
    // rAF 合并：一帧最多一次 IPC，避免高频拖动打满通道
    pendingPoint = { x: event.clientX, y: event.clientY, stamp: Date.now() };
    if (sashRaf) return;
    sashRaf = requestAnimationFrame(() => {
      sashRaf = 0;
      const id = sashDragId;
      if (!id || !pendingPoint) return;
      const point = pendingPoint;
      pendingPoint = null;
      void window.piWebTabs.setSashRatio(id, point.x, point.y, point.stamp);
    });
  });

  el.addEventListener("pointerup", finishSashDrag);
  el.addEventListener("pointercancel", finishSashDrag);
  el.addEventListener("lostpointercapture", finishSashDrag);
}

/** 每个 SplitNode 渲染一条分隔条；按 id 复用 DOM，位置与方向来自主进程的同一份结果 */
function renderSashes(split: SplitSnapshot): void {
  const seen = new Set<string>();
  for (const sash of split.sashes) {
    seen.add(sash.id);
    let el = sashEls.get(sash.id);
    if (!el) {
      el = document.createElement("div");
      el.className = "sash";
      el.dataset.id = sash.id;
      bindSash(el);
      sashEls.set(sash.id, el);
      sashLayer.append(el);
    }
    el.dataset.direction = sash.direction;
    el.style.left = `${sash.x}px`;
    el.style.top = `${sash.y}px`;
    el.style.width = `${sash.width}px`;
    el.style.height = `${sash.height}px`;
  }
  for (const [id, el] of sashEls) {
    if (!seen.has(id)) {
      el.remove();
      sashEls.delete(id);
    }
  }
}

/** 分屏：每个窗格一条自己的页签条，绝对定位到该窗格顶部 */
function renderPaneTabBars(split: SplitSnapshot, current: TabsSnapshot): void {
  const rects = split.rects;
  const topRight = topRightPaneIndex(rects);
  const minY = Math.min(...rects.map((rect) => rect.y));

  split.groups.forEach((group, index) => {
    const rect = rects[index];
    const bar = document.createElement("div");
    bar.className = "pane-tabbar";
    if (index === split.focused) bar.classList.add("is-focused");
    if (index === topRight) bar.classList.add("with-window-tools");
    // 只有顶部那一行的空白条能拖窗口，避免中间/下半部分的页签条误拖
    if (rect.y === minY) bar.classList.add("is-top");
    bar.style.left = `${rect.x}px`;
    bar.style.top = `${rect.y}px`;
    bar.style.width = `${rect.width}px`;

    const paneTabs = document.createElement("div");
    paneTabs.className = "tabs";
    group.tabIds.forEach((id, tabIndex) => {
      const tab = current.tabs.find((item) => item.id === id);
      if (!tab) return;
      paneTabs.append(createTabElement(tab, id === group.activeId, tabIndex));
    });
    bar.append(paneTabs);

    const strip = document.createElement("div");
    strip.className = "drag-strip";
    bar.append(strip);

    const add = document.createElement("button");
    add.className = "tool-button new-tab pane-new-tab";
    add.type = "button";
    add.title = "在此窗格新建页签";
    add.setAttribute("aria-label", "在此窗格新建页签");
    add.innerHTML =
      '<svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true">' +
      '<path d="M8 3v10M3 8h10" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" />' +
      "</svg>";
    add.addEventListener("click", () => void window.piWebTabs.newTabInGroup(index));
    bar.append(add);

    // 工具区只有一份 DOM：单栏挂在 .tabbar，分屏挂到最右上那条页签条
    if (index === topRight) bar.append(windowTools);

    bar.addEventListener("contextmenu", (event) => {
      if ((event.target as HTMLElement).closest(".tab")) return;
      event.preventDefault();
      void window.piWebTabs.showGroupMenu(index, event.clientX, event.clientY);
    });

    paneLayer.append(bar);
  });
}

function render(): void {
  if (!snapshot) return;
  // 拖动期间不要重建页签条：否则 drag 源元素被换掉，dragend 可能永远不来
  if (splitDragging) return;
  const current = snapshot;
  const split = current.split;
  const splitMode = split.groups.length > 1;

  // 分隔条元素按 id 复用，绝不整层重建（否则 pointer capture 会丢）
  renderSashes(split);

  if (sashDragging && splitMode) {
    // 拖动中只改位置，不重建页签条 DOM（避免高频重建造成卡顿 / 打断 capture）
    const bars = paneLayer.querySelectorAll<HTMLElement>(".pane-tabbar");
    split.rects.forEach((r, i) => {
      const bar = bars[i];
      if (!bar) return;
      bar.style.left = `${r.x}px`;
      bar.style.top = `${r.y}px`;
      bar.style.width = `${r.width}px`;
    });
    return;
  }

  applyTheme(current.theme, current.customTitleBar);
  tabbar.hidden = splitMode;
  // 工具区里那个全局「+」只在单栏用；分屏时每个窗格都有自己的 +，
  // 否则最右上那一栏会同时出现两个 +。
  newTabButton.hidden = splitMode;
  splitButton.classList.toggle("is-on", splitMode);
  splitButton.setAttribute(
    "aria-label",
    splitMode ? `分屏中，共 ${split.groups.length} 个窗格` : "分屏",
  );

  // 先把工具区从 pane-layer 里救出来（replaceChildren 会连它一起摘掉）
  if (!splitMode && windowTools.parentElement !== tabbar) tabbar.append(windowTools);
  paneLayer.replaceChildren();
  tabsBox.replaceChildren();

  if (splitMode) {
    renderPaneTabBars(split, current);
    return;
  }

  current.tabs.forEach((tab, index) => {
    const el = createTabElement(tab, tab.id === current.activeId, index);
    if (dropIndex !== null && dragId) {
      if (index === dropIndex) el.classList.add("drop-before");
      if (index === dropIndex - 1) el.classList.add("drop-after");
    }
    tabsBox.append(el);
  });
}

function bindDropTarget(): void {
  // 单栏：原来的页签栏内拖动排序（分屏时 tabbar 是 hidden，不会触发）
  tabbar.addEventListener("dragover", (event) => {
    if (!dragId || isSplit()) return;
    event.preventDefault();
    const next = insertionIndexFor(event.clientX);
    if (next !== dropIndex) {
      dropIndex = next;
      render();
    }
  });

  tabbar.addEventListener("drop", (event) => {
    event.preventDefault();
    if (dragId && dropIndex !== null && !isSplit()) {
      const id = dragId;
      const index = dropIndex;
      dragId = null;
      dropIndex = null;
      void window.piWebTabs.move(id, index);
    }
  });

  tabsBox.addEventListener("dblclick", (event) => {
    if ((event.target as HTMLElement).closest(".tab")) return;
    void window.piWebTabs.open("/");
  });

  // 无论 drop 成功还是取消，统一收尾
  document.addEventListener("dragend", () => {
    dragId = null;
    dropIndex = null;
    if (splitDragging) endSplitDrag();
    else render();
  });
}

function renderStatus(state: ServerState): void {
  // 运行 / 复用 / 异常 / 启动中四种相位各有独立视觉反馈，数据仍来自 ServerState
  statusDot.className = "dot";
  if (state.phase === "ready") statusDot.classList.add(state.managed ? "ok" : "warn");
  else if (state.phase === "failed") statusDot.classList.add("err");
  else statusDot.classList.add("pending");
  status.dataset.phase = state.phase;

  // 端口是主信息；版本 / 复用 / 失败原因弱化为次要信息
  const extras: string[] = [];
  if (state.version) extras.push(`v${state.version}`);
  if (state.phase === "ready" && !state.managed) extras.push("复用");
  if (state.phase === "failed") extras.push("启动失败");
  statusText.textContent = state.port
    ? String(state.port)
    : state.phase === "failed"
      ? "服务异常"
      : "…";
  statusExtra.textContent = extras.length ? ` · ${extras.join(" · ")}` : "";

  status.setAttribute(
    "title",
    state.phase === "ready"
      ? `${state.url ?? ""}${state.managed ? "" : "（复用已在运行的实例）"}`
      : (state.message ?? "正在启动服务…"),
  );
}

async function main(): Promise<void> {
  bindDropTarget();
  // 落在窗格间隙时也要允许拖放（否则会显示「禁止」光标）
  dragOverlay.addEventListener("dragover", (event) => event.preventDefault());
  // 窗口失焦时鼠标很可能已在别处松开，统一收尾（主进程还有 mouseUp / 看门狗兜底）
  window.addEventListener("blur", () => {
    finishSashDrag();
    if (splitDragging) endSplitDrag();
  });
  // Esc 取消拖放：预览从不改真实树，收尾即完全恢复原状态
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && splitDragging) endSplitDrag();
  });

  newTabButton.addEventListener("click", () => void window.piWebTabs.open("/"));
  settingsButton.addEventListener("click", () => void window.piWebTabs.openSettings());
  splitButton.addEventListener("click", () => {
    const rect = splitButton.getBoundingClientRect();
    void window.piWebTabs.showSplitMenu(rect.left, rect.bottom);
  });

  window.piWebTabs.onTabs((next) => {
    snapshot = next;
    render();
  });
  window.piWebTabs.onServerState(renderStatus);

  snapshot = await window.piWebTabs.list();
  render();
  renderStatus(await window.piWebTabs.getServerState());
}

void main();
