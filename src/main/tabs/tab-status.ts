/**
 * 页签状态探测（零侵入：不修改 pi-web 源码/构建产物，只在页面 realm 里注入只读脚本）。
 *
 * 架构：把「全局运行状态」和「页签当前会话」拆开，避免 N 个页签重复请求同一个全局接口。
 *
 *  A. 全局运行状态：只由主进程选出的「一个」有效页面 realm 请求 /api/agent/running，
 *     拿到快照后由主进程共享给所有页签。其它页面即使装了脚本也不会发请求。
 *     请求仍在页面 realm 里发起，Cookie / Basic Auth 登录态自动带上，主进程不碰密码。
 *  B. 页签当前会话：每个页面只提供 sessionId / 来源 / 侧栏 DOM 兜底 / 页面初始化情况。
 *  C. 主进程用 status-model.ts 把 A + B 折算成每个页签的 running / awaiting。
 *
 * 依赖的上游契约（见 docs/development/pi-web-compatibility.md）：
 *  - GET /api/agent/running → runningSessionIds / awaitingInputSessionIds /
 *    subagentsActiveSessionIds（pi-web 侧栏的转圈/橙点也来自这里）
 *  - ?session=<id> → 定位「这个页签当前选中的对话」
 *  - .session-tree-row.session-tree-session.is-selected[data-row-key] → URL 无 session 时兜底
 *
 * ⚠️ 刻意**不读** `pi-web:unread-session-ids`：它是同源 localStorage，被所有页签共享，
 *    而且 pi-web 在每个页面里都会给「非当前会话」写标记、后台页签又不会清理，长期残留
 *    一堆历史会话。它是「会话级」语义，拿来做「页签级」提示会让所有页签一起亮。
 *    「回答完毕未查看」由主进程按页签追踪 running→idle 跳变（见 tab-manager.ts）。
 *
 * ⚠️ 所有注入脚本都用 String.raw，内部不写模板字符串 / 正则，避免转义把脚本写坏
 *    （历史上主题探测踩过这个坑，check:theme / check:status 会锁住这一点）。
 */

/** 每个页面 realm 提供的「本页签当前会话」信息（不含任何网络请求） */
export interface TabSessionProbe {
  /** 该页签当前选中的会话 id；拿不到时为 null（空会话 / 登录页） */
  sessionId: string | null;
  /** id 来源：url 最可靠，dom 是侧栏选中行兜底 */
  sessionSource: "url" | "dom" | null;
  /** 侧栏选中行的逐行状态，接口不可用时的兜底 */
  domRunning: boolean;
  domAwaiting: boolean;
  /** DOM 契约是否仍然可用（选中行存在） */
  hasSelectedRow: boolean;
  /** 页面是否已完成初始化（用于判断「未知」而不是「空闲」） */
  pageReady: boolean;
}

/** 全局运行状态快照：N 个页签共享这一份 */
export interface GlobalStatusSnapshot {
  runningSessionIds: string[];
  awaitingInputSessionIds: string[];
  subagentsActiveSessionIds: string[];
  /** 最后一次成功刷新的时间戳 */
  at: number;
  /** 是否至少成功拉过一次接口 */
  ready: boolean;
  /** 最近一次请求是否成功；false 时数组仍是「最后一次有效状态」，不能被当成 idle */
  ok: boolean;
}

/** 主进程折算后交给 applyTabStatus 的形状（语义与改造前一致） */
export interface TabStatusProbe {
  sessionId: string | null;
  sessionSource: "url" | "dom" | null;
  running: boolean;
  awaiting: boolean;
  /** 全局快照是否至少成功过一次（调试用） */
  ready: boolean;
}

/* ------------------------- A. 全局运行状态 ------------------------- */

/**
 * 装在每个页面 realm 里，但**不会自己发请求**：只有主进程把该页面选为状态源时，
 * 才会执行 GLOBAL_STATUS_READ_SCRIPT → read() → refresh()。
 * 所以 N 个页签每个轮询周期最多只有 1 个 /api/agent/running 请求。
 * 幂等：dom-ready / did-finish-load 会各执行一次，重复执行直接返回。
 */
export const GLOBAL_STATUS_PROBE_SCRIPT = String.raw`(() => {
  if (window.__piDesktopGlobalStatus) return;

  var cache = { running: [], awaiting: [], subagents: [], at: 0, ready: false, ok: false };
  var polling = false;
  var TTL = 600;

  function refresh() {
    if (polling) return;
    // 上一次还没结束、或缓存还新鲜，都不再启动新请求
    if (cache.ready && Date.now() - cache.at < TTL) return;
    polling = true;
    var controller = typeof AbortController === "function" ? new AbortController() : null;
    var timer = controller ? setTimeout(function () { controller.abort(); }, 3000) : null;
    fetch("/api/agent/running", {
      cache: "no-store",
      signal: controller ? controller.signal : undefined
    }).then(function (response) {
      if (!response.ok) throw new Error("HTTP " + response.status);
      return response.json();
    }).then(function (data) {
      if (!data || typeof data !== "object" ||
          !Array.isArray(data.runningSessionIds) ||
          !Array.isArray(data.awaitingInputSessionIds) ||
          !Array.isArray(data.subagentsActiveSessionIds)) {
        throw new Error("unexpected /api/agent/running payload");
      }
      cache.running = data.runningSessionIds;
      cache.awaiting = data.awaitingInputSessionIds;
      cache.subagents = data.subagentsActiveSessionIds;
      cache.ready = true;
      cache.ok = true;
      cache.at = Date.now();
    }).catch(function () {
      // 服务重启 / 登录页 / 网络抖动：保留最后一次有效状态，只把 ok 置 false。
      // 主进程会继续用这份数组，不会因为一次失败就把 running 清成 idle。
      cache.ok = false;
    }).then(function () {
      if (timer !== null) clearTimeout(timer);
      polling = false;
    });
  }

  function read() {
    // 后台刷新，read() 本身同步返回，主进程的轮询不会被网络拖住
    void refresh();
    return {
      runningSessionIds: cache.running.slice(),
      awaitingInputSessionIds: cache.awaiting.slice(),
      subagentsActiveSessionIds: cache.subagents.slice(),
      at: cache.at,
      ready: cache.ready,
      ok: cache.ok
    };
  }

  window.__piDesktopGlobalStatus = { read: read, refresh: refresh };
  // 刻意不在这里调用 refresh()：只有被选为状态源的页面才会请求。
})()`;

/** 主进程只在「状态源」页面上执行；返回 JSON 字符串避免结构化克隆的边界问题 */
export const GLOBAL_STATUS_READ_SCRIPT = String.raw`(() => {
  try {
    var probe = window.__piDesktopGlobalStatus;
    return probe ? JSON.stringify(probe.read()) : "null";
  } catch (error) {
    return JSON.stringify({ error: String(error) });
  }
})()`;

/* ------------------------- B. 页签当前会话 ------------------------- */

/** 装在每个页面 realm 里，纯只读、不发请求、不装定时器 */
export const TAB_SESSION_PROBE_SCRIPT = String.raw`(() => {
  if (window.__piDesktopTabSession) return;

  function selectedRow() {
    try {
      return document.querySelector(".session-tree-row.session-tree-session.is-selected");
    } catch (e) {
      return null;
    }
  }

  function currentSession(row) {
    try {
      var fromUrl = new URLSearchParams(window.location.search).get("session");
      if (fromUrl) return { id: fromUrl, source: "url" };
    } catch (e) {}
    if (!row) return { id: null, source: null };
    // data-row-key = "session:<context>:<sessionId>"
    var parts = String(row.getAttribute("data-row-key") || "").split(":");
    var id = parts.length >= 3 ? parts.slice(2).join(":") || null : null;
    return { id: id, source: id ? "dom" : null };
  }

  function read() {
    var row = selectedRow();
    var current = currentSession(row);
    return {
      sessionId: current.id,
      sessionSource: current.source,
      domRunning: !!(row && row.classList.contains("is-running")),
      domAwaiting: !!(row && row.querySelector(".session-tree-awaiting")),
      hasSelectedRow: !!row,
      pageReady: document.readyState === "complete" && !!document.body
    };
  }

  window.__piDesktopTabSession = { read: read };
})()`;

/** 主进程对每个页签执行；返回 JSON 字符串 */
export const TAB_SESSION_READ_SCRIPT = String.raw`(() => {
  try {
    var probe = window.__piDesktopTabSession;
    return probe ? JSON.stringify(probe.read()) : "null";
  } catch (error) {
    return JSON.stringify({ error: String(error) });
  }
})()`;
