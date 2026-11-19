/**
 * 独立输入工作区的面板渲染层（跑在窗口自己的渲染进程，不进 pi-web DOM）。
 *
 * - 面板是普通 HTML/CSS；主进程把 pi-web 内容视图收窄让出右侧空间，所以不遮挡对话；
 * - 字体 / 字号 / 行高 / 颜色直接读 pi-web 原生 textarea 的 computed style，保持一致；
 * - 底部只留「一个提交按钮 + ▾ 下拉」，模式切换与「在原生输入框中继续」收进菜单；
 * - 成功提示自动消失、失败提示保留、重新输入即清除；
 * - 附件 chip 可点开大图预览。
 */

import type { ComposerMode, DraftSnapshot } from "../../shared/types";

const panel = document.getElementById("draft-panel") as HTMLElement;
const resizer = document.getElementById("draft-resizer") as HTMLDivElement;
const toggleButton = document.getElementById("draft-toggle") as HTMLButtonElement;
const closeButton = document.getElementById("draft-close") as HTMLButtonElement;
const editor = document.getElementById("draft-editor") as HTMLTextAreaElement;
const sendButton = document.getElementById("draft-send") as HTMLButtonElement;
const contextMenu = document.getElementById("draft-context") as HTMLDivElement;
const contextNative = document.getElementById("draft-context-native") as HTMLButtonElement;
const tabLabel = document.getElementById("draft-tab") as HTMLSpanElement;
const countLabel = document.getElementById("draft-count") as HTMLSpanElement;
const compatBox = document.getElementById("draft-compat") as HTMLDivElement;
const resultBox = document.getElementById("draft-result") as HTMLDivElement;
const attachmentsBox = document.getElementById("draft-attachments") as HTMLDivElement;
const attachButton = document.getElementById("draft-attach") as HTMLButtonElement;
const fileInput = document.getElementById("draft-file") as HTMLInputElement;
const lightbox = document.getElementById("draft-lightbox") as HTMLDivElement;
const lightboxImg = document.getElementById("draft-lightbox-img") as HTMLImageElement;
const lightboxName = document.getElementById("draft-lightbox-name") as HTMLSpanElement;
const lightboxClose = document.getElementById("draft-lightbox-close") as HTMLButtonElement;

let current: DraftSnapshot | null = null;
let lastContext = "";
let saveTimer: number | null = null;
let dragging = false;
let dragStartX = 0;
let dragStartWidth = 0;
let resultKey = "";
let resultTimer: number | null = null;

const SEND_LABEL: Record<ComposerMode, string> = {
  send: "发送到对话",
  steer: "发送引导",
  followUp: "排队后续消息",
};

function flush(): Promise<void> {
  if (saveTimer !== null) {
    window.clearTimeout(saveTimer);
    saveTimer = null;
  }
  return window.piWebDrafts.setText(editor.value);
}

function closeContext(): void {
  contextMenu.hidden = true;
}

async function openInNative(): Promise<void> {
  closeContext();
  await flush();
  await window.piWebDrafts.openInNative();
}

function render(snapshot: DraftSnapshot): void {
  current = snapshot;
  const visible = snapshot.enabled && snapshot.open;
  panel.hidden = !visible;
  if (!visible) closeContext();
  panel.style.width = `${snapshot.panelWidth}px`;
  toggleButton.classList.toggle("is-on", snapshot.open);
  toggleButton.disabled = !snapshot.enabled;
  toggleButton.title = snapshot.enabled
    ? "独立输入工作区（右侧编辑长文本）"
    : "独立输入工作区已关闭，pi-web 原生输入框不受影响";

  // 字体与原生输入框保持一致（探针读的是原生 textarea 的 computed style）
  if (snapshot.typography) {
    const t = snapshot.typography;
    editor.style.fontFamily = t.fontFamily;
    editor.style.fontSize = t.fontSize;
    editor.style.lineHeight = t.lineHeight;
    editor.style.color = t.color;
    editor.style.letterSpacing = t.letterSpacing;
  }

  tabLabel.textContent = snapshot.tabId
    ? `${snapshot.tabTitle || "新页签"} · ${snapshot.sessionKey ?? "—"}`
    : "没有可用的页签";

  const context = `${snapshot.tabId ?? ""}::${snapshot.sessionKey ?? ""}`;
  const contextChanged = context !== lastContext;
  lastContext = context;
  // 切页签 / 切会话必须立刻换成对应草稿；其余时候不打断用户正在输入
  if (contextChanged || document.activeElement !== editor) {
    if (editor.value !== snapshot.text) editor.value = snapshot.text;
  }
  countLabel.textContent = `${editor.value.length} 字`;

  if (snapshot.compat.level === "compatible") {
    compatBox.hidden = true;
  } else {
    compatBox.hidden = false;
    compatBox.dataset.level = snapshot.compat.level;
    compatBox.textContent = `兼容性：${snapshot.compat.level} — ${snapshot.compat.reason}`;
  }

  // 只有一个主按钮：文案随主进程自动判定的模式变化（空闲→发送，Agent 运行中→引导/后续消息）
  sendButton.textContent = snapshot.sending ? "提交中…" : SEND_LABEL[snapshot.mode];
  sendButton.title =
    snapshot.mode === "send"
      ? "通过 pi-web 原生发送按钮提交（Ctrl+Enter）"
      : snapshot.mode === "steer"
        ? "Agent 运行中：通过 pi-web 原生「引导」按钮提交（Ctrl+Enter）"
        : "Agent 运行中：通过 pi-web 原生「后续消息」按钮排队（Ctrl+Enter）";
  sendButton.disabled = !snapshot.canSend || snapshot.sending;

  // 图片附件：整块 chip 可点开大图
  attachButton.classList.toggle("has-images", snapshot.attachments.length > 0);
  attachmentsBox.replaceChildren();
  attachmentsBox.hidden = snapshot.attachments.length === 0;
  for (const attachment of snapshot.attachments) {
    const chip = document.createElement("div");
    chip.className = "draft-attachment";
    chip.title = "点击查看大图";
    const name = document.createElement("span");
    name.textContent = `${attachment.name} (${Math.round(attachment.size / 1024)}KB)`;
    const remove = document.createElement("button");
    remove.type = "button";
    remove.textContent = "×";
    remove.title = "移除图片";
    remove.addEventListener("click", (event) => {
      event.stopPropagation();
      void window.piWebDrafts.removeImage(attachment.id);
    });
    chip.append(name, remove);
    chip.addEventListener("click", () => void previewImage(attachment.id));
    attachmentsBox.append(chip);
  }

  // 结果提示：成功 4 秒自动消失；失败保留原因；重新输入时主进程会清掉 lastResult
  if (snapshot.lastResult) {
    const key = `${snapshot.lastResult.ok}:${snapshot.lastResult.reason}`;
    if (key !== resultKey) {
      resultKey = key;
      resultBox.hidden = false;
      resultBox.dataset.ok = String(snapshot.lastResult.ok);
      resultBox.style.opacity = "1";
      resultBox.textContent = `${snapshot.lastResult.ok ? "✓" : "✗"} ${snapshot.lastResult.reason}`;
      if (resultTimer !== null) window.clearTimeout(resultTimer);
      resultTimer = null;
      if (snapshot.lastResult.ok) {
        resultTimer = window.setTimeout(() => {
          resultBox.style.opacity = "0";
          window.setTimeout(() => { resultBox.hidden = true; }, 260);
          resultTimer = null;
        }, 4_000);
      }
    }
  } else {
    resultKey = "";
    resultBox.hidden = true;
    resultBox.style.opacity = "1";
    if (resultTimer !== null) {
      window.clearTimeout(resultTimer);
      resultTimer = null;
    }
  }

  editor.placeholder = snapshot.enabled
    ? "在这里写长文本（Markdown 文本、粘贴 / 拖入图片、@ 文件路径）… Ctrl+Enter 发送"
    : "独立输入工作区已关闭";
}

async function previewImage(id: string): Promise<void> {
  const image = await window.piWebDrafts.getImage(id);
  if (!image) return;
  lightboxImg.src = `data:${image.mimeType};base64,${image.data}`;
  lightboxImg.alt = image.name;
  lightboxName.textContent = image.name;
  lightbox.hidden = false;
}

function closeLightbox(): void {
  lightbox.hidden = true;
  lightboxImg.removeAttribute("src");
}

async function doSend(): Promise<void> {
  if (!current || !current.canSend || current.sending) return;
  closeContext();
  sendButton.disabled = true;
  try {
    await flush();
    // 模式由主进程按 pi-web 当前状态自动决定，渲染层不指定
    await window.piWebDrafts.send();
  } finally {
    sendButton.disabled = Boolean(current?.sending);
  }
}

/** 图片交给主进程，最终由 pi-web 原生 onPaste 处理，不自己构造请求体 */
function readImages(files: File[]): Promise<{ data: string; mimeType: string; name: string }[]> {
  const picked = files.filter((file) => file.type.startsWith("image/")).slice(0, 10);
  return Promise.all(
    picked.map(
      (file) =>
        new Promise<{ data: string; mimeType: string; name: string } | null>((resolve) => {
          const reader = new FileReader();
          reader.onload = () => {
            const result = String(reader.result ?? "");
            const comma = result.indexOf(",");
            if (comma < 0) return resolve(null);
            resolve({ data: result.slice(comma + 1), mimeType: file.type, name: file.name });
          };
          reader.onerror = () => resolve(null);
          reader.readAsDataURL(file);
        }),
    ),
  ).then((list) => list.filter((item): item is { data: string; mimeType: string; name: string } => !!item));
}

async function acceptFiles(files: File[]): Promise<void> {
  const images = await readImages(files);
  if (images.length) await window.piWebDrafts.addImages(images);
}

editor.addEventListener("input", () => {
  countLabel.textContent = `${editor.value.length} 字`;
  if (saveTimer !== null) window.clearTimeout(saveTimer);
  saveTimer = window.setTimeout(() => {
    saveTimer = null;
    void window.piWebDrafts.setText(editor.value);
  }, 80);
});

editor.addEventListener("paste", (event) => {
  const items = Array.from(event.clipboardData?.items ?? []);
  const files = items
    .filter((item) => item.kind === "file" && item.type.startsWith("image/"))
    .map((item) => item.getAsFile())
    .filter((file): file is File => !!file);
  if (!files.length) return; // 纯文本交给原生粘贴行为
  event.preventDefault();
  void acceptFiles(files);
});

editor.addEventListener("dragover", (event) => event.preventDefault());
editor.addEventListener("drop", (event) => {
  const files = Array.from(event.dataTransfer?.files ?? []);
  if (!files.some((file) => file.type.startsWith("image/"))) return;
  event.preventDefault();
  void acceptFiles(files);
});

editor.addEventListener("keydown", (event) => {
  if (event.key === "Escape") {
    if (!lightbox.hidden) return; // 交给 window 上的统一处理
    event.preventDefault();
    closeContext();
    void flush().then(() => window.piWebDrafts.close());
    return;
  }
  if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) {
    event.preventDefault();
    if (event.shiftKey) void openInNative();
    else void doSend();
  }
});

window.addEventListener("keydown", (event) => {
  if (event.key !== "Escape") return;
  if (!lightbox.hidden) { closeLightbox(); return; }
  if (!contextMenu.hidden) closeContext();
});

sendButton.addEventListener("click", () => void doSend());
closeButton.addEventListener("click", () => void flush().then(() => window.piWebDrafts.close()));
toggleButton.addEventListener("click", () => void window.piWebDrafts.toggle());
attachButton.addEventListener("click", () => fileInput.click());
fileInput.addEventListener("change", () => {
  void acceptFiles(Array.from(fileInput.files ?? []));
  fileInput.value = "";
});

/* ---------------- 编辑器右键菜单：唯一不占可见空间的额外入口 ---------------- */
editor.addEventListener("contextmenu", (event) => {
  event.preventDefault();
  contextMenu.style.left = `${Math.min(event.clientX, window.innerWidth - 220)}px`;
  contextMenu.style.top = `${Math.min(event.clientY, window.innerHeight - 60)}px`;
  contextMenu.hidden = false;
});
contextNative.addEventListener("click", (event) => {
  event.stopPropagation();
  void openInNative();
});
window.addEventListener("click", (event) => {
  if (!contextMenu.hidden && !contextMenu.contains(event.target as Node)) closeContext();
});

/* ---------------- 图片预览 ---------------- */
lightboxClose.addEventListener("click", (event) => { event.stopPropagation(); closeLightbox(); });
lightbox.addEventListener("click", (event) => {
  const target = event.target as HTMLElement;
  // 点图片本身或标题栏不关，点其余空白关闭
  if (target === lightboxImg || target.closest(".draft-lightbox-head")) return;
  closeLightbox();
});

/* ---------------- 拖动分隔条调整宽度 ---------------- */
resizer.addEventListener("pointerdown", (event) => {
  if (!current) return;
  dragging = true;
  dragStartX = event.clientX;
  dragStartWidth = current.panelWidth;
  resizer.classList.add("is-dragging");
  resizer.setPointerCapture(event.pointerId);
  event.preventDefault();
});
window.addEventListener("pointermove", (event) => {
  if (!dragging) return;
  // 面板在右侧：向左拖 → 变宽
  void window.piWebDrafts.setWidth(dragStartWidth + (dragStartX - event.clientX));
});
window.addEventListener("pointerup", () => {
  if (!dragging) return;
  dragging = false;
  resizer.classList.remove("is-dragging");
});

async function main(): Promise<void> {
  window.piWebDrafts.onChange(render);
  render(await window.piWebDrafts.get());
}

void main();
