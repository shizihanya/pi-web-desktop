import type {
  LanAddress,
  PiUpdateProgress,
  PiWebUpdateProgress,
  SettingsView,
} from "../../shared/types";

if (new URLSearchParams(location.search).get("titlebar") === "overlay") {
  document.documentElement.dataset.titlebar = "overlay";
}

const el = <T extends HTMLElement>(id: string): T => {
  const node = document.getElementById(id);
  if (!node) throw new Error(`missing #${id}`);
  return node as T;
};

const closeBehavior = el<HTMLSelectElement>("close-behavior");
const alwaysOnTop = el<HTMLInputElement>("always-on-top");
const launchAtLogin = el<HTMLInputElement>("launch-at-login");
const loginRow = el<HTMLLabelElement>("login-row");
const restoreTabs = el<HTMLInputElement>("restore-tabs");
const port = el<HTMLInputElement>("port");
const portNote = el<HTMLElement>("port-note");
const piwebInfo = el<HTMLElement>("piweb-info");
const serverInfo = el<HTMLElement>("server-info");
const remoteEnabled = el<HTMLInputElement>("remote-enabled");
const remoteBox = el<HTMLDivElement>("remote-box");
const password = el<HTMLInputElement>("password");
const passwordState = el<HTMLSpanElement>("password-state");
const lanList = el<HTMLUListElement>("lan-list");
const firewallCmd = el<HTMLElement>("firewall-cmd");
const status = el<HTMLSpanElement>("status");
const dataDirLabel = el<HTMLSpanElement>("data-dir");
const checkUpdate = el<HTMLButtonElement>("check-piweb-update");
const updateLog = el<HTMLPreElement>("piweb-update-log");
const checkPiUpdate = el<HTMLButtonElement>("check-pi-update");
const piUpdateLog = el<HTMLPreElement>("pi-update-log");

const contentScroll = el<HTMLElement>("content-scroll");
const navItems = Array.from(document.querySelectorAll<HTMLButtonElement>(".nav-item"));
const sections = Array.from(document.querySelectorAll<HTMLElement>(".settings-section"));
const sectionScroll = new Map<string, number>();

let view: SettingsView | null = null;
let activeSectionId = "section-window";
let passwordTouched = false;
let updateRunning = false;
let piUpdateRunning = false;

const PHASE_LABEL: Record<SettingsView["server"]["phase"], string> = {
  idle: "未启动",
  resolving: "定位安装",
  starting: "启动中",
  ready: "运行中",
  failed: "启动失败",
};

const UPDATE_TAG: Record<PiWebUpdateProgress["phase"], string> = {
  checking: "检查",
  stopping: "停服",
  installing: "安装",
  restarting: "重启",
  "up-to-date": "完成",
  done: "完成",
  failed: "失败",
};

const PI_UPDATE_TAG: Record<PiUpdateProgress["phase"], string> = {
  checking: "检查",
  updating: "更新",
  "up-to-date": "完成",
  done: "完成",
  failed: "失败",
};

/** 只切换可见性，不改任何表单值，避免未保存的修改在分类切换时丢失。 */
function activateSection(id: string): void {
  const section = sections.find((item) => item.id === id);
  if (!section) return;

  sectionScroll.set(activeSectionId, contentScroll.scrollTop);
  activeSectionId = id;

  for (const item of navItems) {
    const active = item.dataset.target === id;
    item.classList.toggle("is-active", active);
    if (active) item.setAttribute("aria-current", "page");
    else item.removeAttribute("aria-current");
  }

  for (const item of sections) item.hidden = item.id !== id;
  contentScroll.scrollTop = sectionScroll.get(id) ?? 0;
}

function setStatus(text: string, kind: "ok" | "err" | "" = ""): void {
  status.textContent = text;
  status.className = `status ${kind}`.trim();
}

function renderLan(addresses: LanAddress[], serverPort: number): void {
  lanList.replaceChildren();
  if (addresses.length === 0) {
    const li = document.createElement("li");
    const span = document.createElement("span");
    span.className = "empty";
    span.textContent = "没有找到可用的局域网地址（检查是否连上 Wi-Fi / 有线网络）";
    li.append(span);
    lanList.append(li);
    return;
  }
  for (const item of addresses) {
    const li = document.createElement("li");
    const iface = document.createElement("span");
    iface.className = "iface";
    iface.textContent = item.name;
    const url = document.createElement("span");
    url.textContent = item.url;
    const copy = document.createElement("button");
    copy.type = "button";
    copy.className = "copy";
    copy.textContent = "复制";
    copy.addEventListener("click", () => {
      void window.piWebSettings.copy(item.url);
      setStatus(`已复制 ${item.url}`, "ok");
    });
    li.append(iface, url, copy);
    lanList.append(li);
  }
  firewallCmd.textContent = `netsh advfirewall firewall add rule name="Pi Web Desktop" dir=in action=allow protocol=TCP localport=${serverPort}`;
}

function render(next: SettingsView): void {
  view = next;

  closeBehavior.value = next.closeBehavior;
  alwaysOnTop.checked = next.alwaysOnTop;
  launchAtLogin.checked = next.launchAtLogin;
  restoreTabs.checked = next.restoreTabs;
  port.value = String(next.port);
  portNote.textContent = `端口被占用时会自动尝试 ${next.portFallbackRange[0]}–${next.portFallbackRange[1]}。`;

  if (next.portable) {
    loginRow.classList.add("disabled");
    launchAtLogin.disabled = true;
    loginRow.title = "绿色版路径可能变化，不支持开机自启";
  } else {
    loginRow.classList.remove("disabled");
    launchAtLogin.disabled = false;
    loginRow.removeAttribute("title");
  }

  const resolved = next.resolved;
  piwebInfo.textContent = resolved
    ? `v${resolved.version} · node ${resolved.nodeVersion}\n${resolved.scriptPath}`
    : "未找到（请先 npm i -g @agegr/pi-web）";
  piwebInfo.style.whiteSpace = "pre-wrap";

  const server = next.server;
  serverInfo.textContent = server.phase === "ready"
    ? `${PHASE_LABEL[server.phase]} · ${server.url}${server.managed ? "" : "（复用外部实例）"}`
    : `${PHASE_LABEL[server.phase]}${server.message ? ` · ${server.message}` : ""}`;

  remoteEnabled.checked = next.remoteAccessEnabled;
  remoteBox.hidden = !next.remoteAccessEnabled;
  passwordState.textContent = next.hasPassword ? "已保存密码（留空表示不修改）" : "尚未设置密码";
  password.placeholder = next.hasPassword ? "留空表示不修改" : "至少 8 位";

  renderLan(next.lanAddresses, next.port);
  dataDirLabel.textContent = next.dataDir;
}

function collect(): Parameters<typeof window.piWebSettings.save>[0] {
  const passwordValue = password.value.trim();
  return {
    port: Number(port.value),
    closeBehavior: closeBehavior.value === "quit" ? "quit" : "tray",
    alwaysOnTop: alwaysOnTop.checked,
    launchAtLogin: launchAtLogin.checked,
    restoreTabs: restoreTabs.checked,
    remoteAccess: {
      enabled: remoteEnabled.checked,
      // 没动过密码输入框就不传，避免把已保存的密码清掉
      ...(passwordTouched && passwordValue.length > 0 ? { password: passwordValue } : {}),
      ...(passwordTouched && passwordValue.length === 0 && !view?.hasPassword ? { password: null } : {}),
    },
  };
}

/** 一键：检查 → 停服 → npm 全局更新 → 重启服务 */
async function runPiWebUpdate(): Promise<void> {
  if (updateRunning || piUpdateRunning) return;
  updateRunning = true;
  const buttons = [
    checkUpdate,
    checkPiUpdate,
    el<HTMLButtonElement>("save"),
    el<HTMLButtonElement>("save-restart"),
  ];
  for (const button of buttons) button.disabled = true;
  updateLog.hidden = false;
  updateLog.textContent = "";
  setStatus("正在检查 pi-web 更新…");

  const append = (line: string): void => {
    updateLog.textContent += `${line}\n`;
    updateLog.scrollTop = updateLog.scrollHeight;
  };

  const off = window.piWebSettings.onPiWebUpdate((progress) => {
    if (progress.log) {
      append(progress.log);
      return;
    }
    append(`[${UPDATE_TAG[progress.phase]}] ${progress.message}`);
    const kind = progress.phase === "failed" ? "err"
      : progress.phase === "done" || progress.phase === "up-to-date" ? "ok"
      : "";
    setStatus(progress.message, kind);
  });

  try {
    const result = await window.piWebSettings.updatePiWeb();
    render(result.view);
    setStatus(result.message, result.ok ? "ok" : "err");
    if (!result.ok) append(`[失败] ${result.message}`);
  } catch (error) {
    const message = `更新失败：${String(error)}`;
    setStatus(message, "err");
    append(message);
  } finally {
    off();
    updateRunning = false;
    for (const button of buttons) button.disabled = false;
  }
}

/** pi 自带「检查 + 按需更新」：直接走 pi update --all。 */
async function runPiUpdate(): Promise<void> {
  if (updateRunning || piUpdateRunning) return;
  piUpdateRunning = true;
  const buttons = [
    checkUpdate,
    checkPiUpdate,
    el<HTMLButtonElement>("save"),
    el<HTMLButtonElement>("save-restart"),
  ];
  for (const button of buttons) button.disabled = true;
  piUpdateLog.hidden = false;
  piUpdateLog.textContent = "";
  setStatus("正在检查 pi / 扩展更新…");

  const append = (line: string): void => {
    piUpdateLog.textContent += `${line}\n`;
    piUpdateLog.scrollTop = piUpdateLog.scrollHeight;
  };

  const off = window.piWebSettings.onPiUpdate((progress) => {
    if (progress.log) {
      append(progress.log);
      return;
    }
    append(`[${PI_UPDATE_TAG[progress.phase]}] ${progress.message}`);
    const kind = progress.phase === "failed" ? "err"
      : progress.phase === "done" || progress.phase === "up-to-date" ? "ok"
      : "";
    setStatus(progress.message, kind);
  });

  try {
    const result = await window.piWebSettings.updatePi();
    render(result.view);
    setStatus(result.message, result.ok ? "ok" : "err");
    if (!result.ok) append(`[失败] ${result.message}`);
  } catch (error) {
    const message = `pi 更新失败：${String(error)}`;
    setStatus(message, "err");
    append(message);
  } finally {
    off();
    piUpdateRunning = false;
    for (const button of buttons) button.disabled = false;
  }
}

async function save(withRestart: boolean): Promise<void> {
  if (updateRunning || piUpdateRunning) return;
  const buttons = [
    checkUpdate,
    checkPiUpdate,
    el<HTMLButtonElement>("save"),
    el<HTMLButtonElement>("save-restart"),
  ];
  for (const button of buttons) button.disabled = true;
  setStatus(withRestart ? "正在保存并重启服务…" : "正在保存…");

  try {
    const result = withRestart
      ? await window.piWebSettings.saveAndRestart(collect())
      : await window.piWebSettings.save(collect());

    render(result.view);
    if (!result.ok) {
      setStatus(result.message ?? "保存失败", "err");
      return;
    }
    password.value = "";
    passwordTouched = false;
    setStatus(
      result.needsRestart
        ? withRestart
          ? "已保存并重启服务。"
          : "已保存。端口 / 远程访问的改动需要重启服务后生效。"
        : "已保存。",
      "ok",
    );
  } catch (error) {
    setStatus(`保存失败：${String(error)}`, "err");
  } finally {
    for (const button of buttons) button.disabled = false;
  }
}

async function main(): Promise<void> {
  render(await window.piWebSettings.load());

  for (const item of navItems) {
    item.addEventListener("click", () => activateSection(item.dataset.target ?? "section-window"));
  }
  activateSection("section-window");

  remoteEnabled.addEventListener("change", () => {
    remoteBox.hidden = !remoteEnabled.checked;
  });

  password.addEventListener("input", () => {
    passwordTouched = true;
    passwordState.textContent = password.value.trim() ? "将使用这个新密码" : "留空表示不修改";
  });

  el<HTMLButtonElement>("gen-password").addEventListener("click", async () => {
    password.value = await window.piWebSettings.generatePassword();
    passwordTouched = true;
    passwordState.textContent = "已生成新密码（记得保存）";
    await window.piWebSettings.copy(password.value);
    setStatus("新密码已生成并复制到剪贴板", "ok");
  });

  el<HTMLButtonElement>("refresh-lan").addEventListener("click", async () => {
    const addresses = await window.piWebSettings.refreshLan();
    renderLan(addresses, Number(port.value) || 30141);
    setStatus(addresses.length ? `找到 ${addresses.length} 个局域网地址` : "没有找到局域网地址", "");
  });

  el<HTMLButtonElement>("copy-firewall").addEventListener("click", async () => {
    await window.piWebSettings.copy(firewallCmd.textContent ?? "");
    setStatus("防火墙命令已复制", "ok");
  });

  checkUpdate.addEventListener("click", () => void runPiWebUpdate());
  checkPiUpdate.addEventListener("click", () => void runPiUpdate());
  el<HTMLButtonElement>("save").addEventListener("click", () => void save(false));
  el<HTMLButtonElement>("save-restart").addEventListener("click", () => void save(true));

  // 取消按钮与窗口右上角关闭功能重复，改由 Esc / 窗口控件关闭。
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && !updateRunning && !piUpdateRunning) {
      void window.piWebSettings.close();
    }
  });
}

void main();
