import type {
  ServerState,
  TabInfo,
  TabStatus,
  TabsSnapshot,
  ThemeSnapshot,
} from "../../shared/types";
import { topRightPaneIndex, type PaneRect, type SplitSnapshot } from "../../shared/split";

const tabsBox = document.getElementById("tabs") as HTMLDivElement;
const tabbar = document.getElementById("tabbar") as HTMLDivElement;
const windowTools = document.getElementById("window-tools") as HTMLDivElement;
const paneLayer = document.getElementById("pane-layer") as HTMLDivElement;
const dragOverlay = document.getElementById("drag-overlay") as HTMLDivElement;
const newTabButton = document.getElementById("new-tab") as HTMLButtonElement;
const settingsButton = document.getElementById("open-settings") as HTMLButtonElement;
const splitButton = document.getElementById("split-button") as HTMLButtonElement;
const statusDot = document.getElementById("status-dot") as HTMLSpanElement;
const statusText = document.getElementById("status-text") as HTMLSpanElement;

let snapshot: TabsSnapshot | null = null;
/** 正在拖动的页签 id */
let dragId: string | null = null;
/** 单栏拖动排序时的插入位置 */
let dropIndex: number | null = null;
/** 分屏拖放模式（内容视图已被主进程临时隐藏） */
let splitDragging = false;
/** 上一次写到 :root 的内联变量，主题切换时先清掉 */
let appliedVars: string[] = [];

/** 页签状态的人话说明（同时也进 hover tooltip / 无障碍标签） */
const STATUS_LABEL: Record<TabStatus, string> = {
  idle: "",
  running: "正在等待回答…",
  unread: "回答完毕，尚未查看",
  awaiting: "等待你的确认",
};

const STATUS_SUFFIX: Record<TabStatus, string> = {
  idle: "",
  running: " · 正在等待回答…",
  unread: " · 回答完毕，尚未查看",
  awaiting: " · 等待你的确认",
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
  el.title = (tab.title || "新页签") + STATUS_SUFFIX[tab.status];

  el.append(createIcon(tab));

  const title = document.createElement("span");
  title.className = "tab-title";
  title.textContent = tab.title || "新页签";
  el.append(title);
  el.append(createStatus(tab));

  const close = document.createElement("span");
  close.className = "tab-close";
  close.textContent = "×";
  close.title = "关闭页签 (Ctrl+W)";
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

/* ---------------- 分屏拖动：投放区 ---------------- */

function clearOver(): void {
  for (const zone of dragOverlay.querySelectorAll<HTMLElement>(".drop-zone")) {
    zone.classList.remove("is-over");
  }
}

function ghostInsertIndex(zone: HTMLElement, clientX: number): number {
  const ghosts = [...zone.querySelectorAll<HTMLElement>(".drop-ghost")];
  for (let i = 0; i < ghosts.length; i += 1) {
    const rect = ghosts[i].getBoundingClientRect();
    if (clientX < rect.left + rect.width / 2) return i;
  }
  return ghosts.length;
}

function createDropZone(
  rect: PaneRect,
  title: string,
  ghosts: string[],
  isEdge: boolean,
): HTMLElement {
  const zone = document.createElement("div");
  zone.className = `drop-zone${isEdge ? " drop-edge" : ""}`;
  zone.style.left = `${rect.x}px`;
  zone.style.top = `${rect.y}px`;
  zone.style.width = `${rect.width}px`;
  zone.style.height = `${rect.height}px`;

  const label = document.createElement("div");
  label.className = "drop-zone-title";
  label.textContent = title;
  zone.append(label);

  if (ghosts.length > 0) {
    const box = document.createElement("div");
    box.className = "drop-ghosts";
    for (const text of ghosts) {
      const ghost = document.createElement("span");
      ghost.className = "drop-ghost";
      ghost.textContent = text;
      box.append(ghost);
    }
    zone.append(box);
  }

  zone.addEventListener("dragover", (event) => {
    event.preventDefault();
    if (event.dataTransfer) event.dataTransfer.dropEffect = "move";
    clearOver();
    zone.classList.add("is-over");
  });
  zone.addEventListener("dragleave", () => zone.classList.remove("is-over"));
  zone.addEventListener("drop", (event) => {
    event.preventDefault();
    zone.classList.remove("is-over");
    if (!dragId) return;
    const id = dragId;
    const edge = zone.dataset.edge as "left" | "right" | undefined;
    const insertIndex = edge ? undefined : ghostInsertIndex(zone, event.clientX);
    dragId = null;
    if (edge) void window.piWebTabs.splitTabToEdge(id, edge);
    else void window.piWebTabs.moveTabToGroup(id, Number(zone.dataset.group), insertIndex);
    // 不依赖 dragend：drop 后直接收尾，避免 notify 重建 DOM 让 dragend 丢失
    endSplitDrag();
  });
  return zone;
}

function renderDragOverlay(split: SplitSnapshot, current: TabsSnapshot): void {
  dragOverlay.replaceChildren();
  const width = window.innerWidth;
  const height = window.innerHeight;
  const inset = 6;

  split.groups.forEach((group, index) => {
    const rect = split.rects[index];
    const zone = createDropZone(
      {
        x: rect.x + inset,
        y: rect.y + inset,
        width: Math.max(rect.width - inset * 2, 10),
        height: Math.max(rect.height - inset * 2, 10),
      },
      `窗格 ${index + 1} · 放到这里`,
      group.tabIds.map((id) => current.tabs.find((tab) => tab.id === id)?.title || "新页签"),
      false,
    );
    zone.dataset.group = String(index);
    dragOverlay.append(zone);
  });

  // 拖到最左 / 最右：新建一列（后加的盖在前面，天然优先命中）
  if (split.groups.length < 4) {
    const edgeWidth = Math.max(56, Math.round(width * 0.09));
    const left = createDropZone(
      { x: 2, y: 2, width: edgeWidth, height: height - 4 },
      "左侧新建窗格",
      [],
      true,
    );
    left.dataset.edge = "left";
    const right = createDropZone(
      { x: width - edgeWidth - 2, y: 2, width: edgeWidth, height: height - 4 },
      "右侧新建窗格",
      [],
      true,
    );
    right.dataset.edge = "right";
    dragOverlay.append(left, right);
  }
}

function hideDragOverlay(): void {
  dragOverlay.hidden = true;
  dragOverlay.replaceChildren();
}

function startSplitDrag(): void {
  if (!snapshot || !isSplit() || splitDragging) return;
  splitDragging = true;
  renderDragOverlay(snapshot.split, snapshot);
  dragOverlay.hidden = false;
  // 主进程临时隐藏所有内容视图，投放层才不会被 WebContentsView 盖住
  void window.piWebTabs.beginTabDrag();
}

function endSplitDrag(): void {
  if (!splitDragging) return;
  splitDragging = false;
  hideDragOverlay();
  void window.piWebTabs.endTabDrag();
  render();
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
    add.className = "new-tab pane-new-tab";
    add.type = "button";
    add.title = "在此窗格新建页签";
    add.textContent = "+";
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
  applyTheme(current.theme, current.customTitleBar);
  const split = current.split;
  const splitMode = split.groups.length > 1;

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
  statusDot.className = "dot";
  if (state.phase === "ready") statusDot.classList.add(state.managed ? "ok" : "warn");
  else if (state.phase === "failed") statusDot.classList.add("err");

  const bits: string[] = [];
  if (state.port) bits.push(String(state.port));
  if (state.version) bits.push(`v${state.version}`);
  if (state.phase === "ready" && !state.managed) bits.push("复用");
  if (state.phase === "failed") bits.push("启动失败");
  statusText.textContent = bits.join(" · ") || "…";
  statusText.parentElement?.setAttribute(
    "title",
    state.phase === "ready"
      ? `${state.url ?? ""}${state.managed ? "" : "（复用已在运行的实例）"}`
      : (state.message ?? "正在启动服务…"),
  );
}

async function main(): Promise<void> {
  bindDropTarget();

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
