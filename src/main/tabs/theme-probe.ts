/**
 * 主题探测脚本（零侵入、只读）。
 *
 * 不维护 pi-web 主题配色映射表：直接读页面 :root 上真实生效的 CSS 变量，
 * 上游新增/自定义主题时页签栏与窗口控件自动跟随。
 *
 * 从 tab-manager.ts 抽出来，让 scripts/check-theme-probe.mjs 有一个稳定的检测目标，
 * 也让「主题增强」可以独立关闭、独立降级（见 compat.ts / TabManager）。
 * 用 String.raw 避免模板字符串把正则里的反斜杠吃掉（历史上踩过坑）。
 */

export interface ThemeProbeResult {
  name?: string;
  scheme?: string;
  vars?: Record<string, string>;
  fromPage?: boolean;
  error?: string;
}

/** 页面 realm → 主进程的只读信号（用 console-message 传，不入 preload、不改 pi-web 文件） */
export const THEME_CHANGED_MARKER = "__PI_DESKTOP_THEME_CHANGED__";

/**
 * 主题变化监听脚本（幂等、只读、不装定时器）。
 *
 * pi-web 切主题不发事件给主进程，Electron 的 console-message 是现成的、
 * 不需要往页面塞 preload 的单向通道：observer 只在「真的变了」时打一条标记日志，
 * 主进程收到就立即读一次主题；另有低频轮询作为 observer 失效时的兜底。
 */
export const THEME_CHANGE_OBSERVER_SCRIPT = String.raw`(() => {
  if (window.__piDesktopThemeObserver) return;
  function notify() {
    try { window.__piDesktopThemeDirty = true; } catch (e) {}
    try { console.info("__PI_DESKTOP_THEME_CHANGED__"); } catch (e) {}
  }
  try {
    var root = document.documentElement;
    function signature() {
      return (root.getAttribute("data-theme") || "") + "|" + (root.className || "");
    }
    var last = signature();
    var observer = new MutationObserver(function () {
      var now = signature();
      if (now === last) return;
      last = now;
      notify();
    });
    observer.observe(root, { attributes: true, attributeFilter: ["data-theme", "class"] });
  } catch (e) {}
  try {
    window.addEventListener("storage", function (e) {
      if (!e || e.key === "pi-theme" || e.key === null) notify();
    });
  } catch (e) {}
  try {
    var mq = window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)");
    if (mq && mq.addEventListener) mq.addEventListener("change", notify);
  } catch (e) {}
  try {
    Object.defineProperty(window, "__piDesktopThemeObserver", { value: true });
  } catch (e) {}
})()`;

/** 主题同步依赖的 11 个 CSS 变量；少于 3 个就认为没读到真实主题 */
export const THEME_VARIABLES = [
  "--bg",
  "--bg-panel",
  "--bg-hover",
  "--bg-selected",
  "--border",
  "--text",
  "--text-muted",
  "--text-dim",
  "--accent",
  "--accent-hover",
  "--accent-contrast",
] as const;

export const THEME_PROBE_SCRIPT = String.raw`(() => {
  try {
    const root = document.documentElement;
    const cs = getComputedStyle(root);
    const names = [
      "--bg", "--bg-panel", "--bg-hover", "--bg-selected", "--border",
      "--text", "--text-muted", "--text-dim", "--accent",
      "--accent-hover", "--accent-contrast"
    ];
    const vars = {};
    for (const key of names) {
      const value = cs.getPropertyValue(key).trim();
      if (value) vars[key] = value;
    }

    let name = (root && root.dataset ? root.dataset.theme : "") || "";
    if (!name) {
      try { name = (window.localStorage && localStorage.getItem("pi-theme")) || ""; } catch (e) {}
      if (!name || name === "auto") {
        name = window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
      }
    }

    function toRgb(text) {
      const s = String(text || "").trim();
      let m = /^#([0-9a-f]{3,8})$/i.exec(s);
      if (m) {
        let h = m[1];
        if (h.length === 3 || h.length === 4) h = h.split("").map(c => c + c).join("");
        if (h.length === 6 || h.length === 8) {
          return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
        }
      }
      m = /^rgba?\(([^)]+)\)$/i.exec(s);
      if (m) {
        const parts = m[1].split(/[,/\s]+/).filter(Boolean).map(Number);
        // 全透明背景（例如 about:blank）不算有效颜色，交给 color-scheme / 系统判断
        if (parts.length >= 4 && parts[3] === 0) return null;
        if (parts.length >= 3) return [parts[0], parts[1], parts[2]];
      }
      return null;
    }

    // 明暗以「实际背景色」为准：color-scheme 只作兜底，避免主题类名残留时判断错
    let scheme = "";
    const bgRgb = toRgb(vars["--bg"] || getComputedStyle(document.body).backgroundColor);
    if (bgRgb) {
      const luma = 0.299 * bgRgb[0] + 0.587 * bgRgb[1] + 0.114 * bgRgb[2];
      scheme = luma < 128 ? "dark" : "light";
    }
    if (!scheme) {
      const cssScheme = cs.colorScheme || "";
      if (cssScheme.indexOf("dark") === 0) scheme = "dark";
      else if (cssScheme.indexOf("light") === 0) scheme = "light";
    }
    if (!scheme) {
      scheme = window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
    }

    return JSON.stringify({
      name: name,
      scheme: scheme,
      vars: vars,
      fromPage: Object.keys(vars).length >= 3
    });
  } catch (error) {
    return JSON.stringify({ error: String(error && error.message ? error.message : error) });
  }
})()`;
