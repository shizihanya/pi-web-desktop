import type { ServerState } from "../../shared/types";

const params = new URLSearchParams(location.search);
if (params.get("titlebar") === "overlay") {
  document.documentElement.dataset.titlebar = "overlay";
}

// 主窗口首帧用的是 theme.json 里缓存的 pi-web 主题；启动页跟着它走，
// 切到页签栏时不会从固定深色突然跳成用户主题。
const root = document.documentElement;
const scheme = params.get("scheme");
if (scheme === "light" || scheme === "dark") {
  root.dataset.scheme = scheme;
  root.style.colorScheme = scheme;
}
const bg = params.get("bg");
const fg = params.get("fg");
const accent = params.get("accent");
if (bg) root.style.setProperty("--bg", bg);
if (fg) root.style.setProperty("--text", fg);
if (accent) root.style.setProperty("--accent", accent);

const PHASE_LABEL: Record<ServerState["phase"], string> = {
  idle: "空闲",
  resolving: "定位安装",
  starting: "启动中",
  ready: "已就绪",
  failed: "启动失败",
};

const PHASE_HEADLINE: Record<ServerState["phase"], string> = {
  idle: "准备启动…",
  resolving: "正在定位 pi-web 与 Node.js…",
  starting: "正在启动本机 pi-web 服务…",
  ready: "服务已就绪，正在打开窗口…",
  failed: "没能启动 pi-web。",
};

const MAX_LOG_LINES = 120;

const el = <T extends HTMLElement>(id: string): T => {
  const node = document.getElementById(id);
  if (!node) throw new Error(`missing element #${id}`);
  return node as T;
};

const badge = el<HTMLSpanElement>("phase-badge");
const headline = el<HTMLParagraphElement>("headline");
const subline = el<HTMLParagraphElement>("subline");
const meta = el<HTMLDivElement>("meta");
const metaUrl = el<HTMLSpanElement>("meta-url");
const metaVersion = el<HTMLSpanElement>("meta-version");
const logBox = el<HTMLPreElement>("log");
const btnRetry = el<HTMLButtonElement>("btn-retry");

let logLines: string[] = [];

function appendLog(line: string): void {
  logLines.push(line);
  if (logLines.length > MAX_LOG_LINES) logLines = logLines.slice(-MAX_LOG_LINES);
  logBox.textContent = logLines.join("\n");
  logBox.scrollTop = logBox.scrollHeight;
}

function render(state: ServerState): void {
  badge.textContent = PHASE_LABEL[state.phase];
  headline.textContent = state.message ?? PHASE_HEADLINE[state.phase];

  badge.className = "badge";
  if (state.phase === "ready") badge.classList.add("ok");
  if (state.phase === "failed") badge.classList.add("err");

  const parts: string[] = [];
  if (state.phase === "failed" && state.detail) parts.push(state.detail);
  if (state.phase === "starting") parts.push("首次启动需要加载 Next.js，大约几秒钟。");
  if (state.phase === "ready" && state.url) parts.push(`${state.url}${state.managed ? "" : "（复用已在运行的实例）"}`);
  subline.textContent = parts.join("\n");
  subline.hidden = parts.length === 0;

  meta.hidden = !state.url;
  metaUrl.textContent = state.url ?? "";
  metaVersion.textContent = state.version ? `pi-web v${state.version}` : "";

  btnRetry.hidden = state.phase !== "failed";

  if (state.phase === "failed" && state.detail && logLines.length === 0) {
    appendLog(state.detail);
  }
}

async function main(): Promise<void> {
  const initial = await window.piWebShell.getState();
  logLines = [];
  logBox.textContent = "";
  for (const line of await window.piWebShell.getLogs()) appendLog(line);
  render(initial);

  window.piWebShell.onState(render);
  window.piWebShell.onLog(appendLog);

  btnRetry.addEventListener("click", async () => {
    btnRetry.disabled = true;
    headline.textContent = "正在重启服务…";
    try {
      render(await window.piWebShell.retry());
    } finally {
      btnRetry.disabled = false;
    }
  });

  el<HTMLButtonElement>("btn-log").addEventListener("click", () => void window.piWebShell.openLogFile());
  el<HTMLButtonElement>("btn-data").addEventListener("click", () => void window.piWebShell.openDataFolder());
  el<HTMLButtonElement>("btn-quit").addEventListener("click", () => void window.piWebShell.quit());
}

void main();
