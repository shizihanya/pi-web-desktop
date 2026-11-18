/**
 * ThemeManager（第三 / 四阶段：主题读取、缓存与变化监听从 TabManager 抽出）。
 *
 * 保留「直接读页面 CSS Variables」的方案，不维护 pi-web 主题配色映射表。
 * 读不到变量（页面未加载完 / 上游改变量名 / 页面失效）时一律保留当前主题缓存，
 * 绝不回落浅色、绝不影响 pi-web 显示。
 *
 * 第四阶段的探测优化：
 *  - 页面 realm 里的 MutationObserver / storage / matchMedia 在主题变化时打一条只读
 *    console 标记，主进程通过 console-message 立即收到并读一次（事件驱动）；
 *  - 保留 5s 低频轮询作为 observer 失效 / 漏事件的兜底（原来每秒一次）；
 *  - 事件信号做 120ms 合并，避免切主题时连续刷新。
 *
 * 不 import electron 运行时（只由调用方传入 systemDark / WebContents 结构面），
 * 因此可以在 Node 里用 mock 回归（scripts/check-theme-manager.mjs）。
 */

import { saveTheme } from "./theme-persistence.ts";
import {
  THEME_CHANGED_MARKER,
  THEME_CHANGE_OBSERVER_SCRIPT,
  THEME_PROBE_SCRIPT,
  type ThemeProbeResult,
} from "./theme-probe.ts";
import { evaluateThemeProbe, type CompatVerdict } from "./compat.ts";
import type { ThemeSnapshot } from "../../shared/types.ts";

/** 兜底轮询间隔：事件驱动为主，它只在 observer 失效时起作用 */
export const THEME_FALLBACK_POLL_MS = 5_000;
/** 同一批主题变化合并成一次探测 */
export const THEME_SIGNAL_DEBOUNCE_MS = 120;

export interface ThemeContents {
  isDestroyed(): boolean;
  executeJavaScript(code: string, userGesture?: boolean): Promise<unknown>;
  on(event: string, listener: (...args: any[]) => void): unknown;
  off(event: string, listener: (...args: any[]) => void): unknown;
}

export interface ThemeManagerOptions {
  dataDir: string;
  systemDark: boolean;
  initialTheme?: ThemeSnapshot | null;
  /** 事件信号 / 兜底轮询触发时调用（回到 TabManager.refreshTheme） */
  onRefresh(): void;
  onCompatibility(verdict: CompatVerdict): void;
  /** 默认写 theme.json；测试可注入以避免落盘 */
  persist?(theme: ThemeSnapshot): void;
  onDebug?(message: string): void;
}

function systemFallbackTheme(dark: boolean): ThemeSnapshot {
  const scheme: "light" | "dark" = dark ? "dark" : "light";
  return { name: scheme, scheme, vars: {}, fromPage: false };
}

export class ThemeManager {
  private currentTheme: ThemeSnapshot;
  private timer: NodeJS.Timeout | null = null;
  private signalTimer: NodeJS.Timeout | null = null;
  private readonly attached = new Map<ThemeContents, { ready: () => void; console: (...args: any[]) => void }>();
  private readonly options: ThemeManagerOptions;
  private lastLevel: string | null = null;

  private report(verdict: CompatVerdict): void {
    this.lastLevel = verdict.level;
    this.options.onCompatibility(verdict);
  }

  private persist(theme: ThemeSnapshot): void {
    if (this.options.persist) this.options.persist(theme);
    else saveTheme(this.options.dataDir, theme);
  }

  constructor(options: ThemeManagerOptions) {
    this.options = options;
    this.currentTheme = options.initialTheme ?? systemFallbackTheme(options.systemDark);
  }

  get current(): ThemeSnapshot {
    return this.currentTheme;
  }

  /** 冷启动首帧就能用缓存主题；start 里也会立刻读一次真实主题 */
  start(): void {
    this.timer = setInterval(() => this.options.onRefresh(), THEME_FALLBACK_POLL_MS);
    this.timer.unref?.();
    this.options.onRefresh();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    if (this.signalTimer) clearTimeout(this.signalTimer);
    this.timer = null;
    this.signalTimer = null;
    this.dispose();
  }

  /** 给新页签安装只读 observer + console 信号监听；页面重载后 realm 重建会自动重装 */
  attach(wc: ThemeContents): void {
    if (this.attached.has(wc)) return;
    const ready = (): void => {
      if (!wc.isDestroyed()) void wc.executeJavaScript(THEME_CHANGE_OBSERVER_SCRIPT, true).catch(() => {});
    };
    const consoleListener = (...args: any[]): void => {
      const details = args[0] as { message?: string } | undefined;
      const legacy = args[2];
      const text = details?.message ?? (typeof legacy === "string" ? legacy : "");
      if (text === THEME_CHANGED_MARKER) this.onThemeSignal();
    };
    wc.on("dom-ready", ready);
    wc.on("did-finish-load", ready);
    wc.on("console-message", consoleListener);
    this.attached.set(wc, { ready, console: consoleListener });
  }

  detach(wc: ThemeContents): void {
    const handlers = this.attached.get(wc);
    if (!handlers) return;
    try {
      wc.off("dom-ready", handlers.ready);
      wc.off("did-finish-load", handlers.ready);
      wc.off("console-message", handlers.console);
    } catch {
      // WebContents 可能已经销毁
    }
    this.attached.delete(wc);
  }

  dispose(): void {
    for (const wc of [...this.attached.keys()]) this.detach(wc);
  }

  /** 合并同一批主题变化信号，触发一次探测 */
  private onThemeSignal(): void {
    if (this.signalTimer) return;
    this.signalTimer = setTimeout(() => {
      this.signalTimer = null;
      this.options.onRefresh();
    }, THEME_SIGNAL_DEBOUNCE_MS);
    this.signalTimer.unref?.();
  }

  /**
   * 读取 pi-web 当前主题的真实 CSS 变量；返回主题是否真的变化。
   * 失败 / 变量不足时保留当前主题，只上报兼容性结论，不抛给调用方。
   */
  async refresh(active: ThemeContents | undefined): Promise<boolean> {
    if (!active || active.isDestroyed()) return false;
    const debug = Boolean(process.env.PI_WEB_DESKTOP_DEBUG_THEME);
    try {
      const value = (await active.executeJavaScript(THEME_PROBE_SCRIPT, true)) as string;
      const payload = JSON.parse(value) as ThemeProbeResult;
      if (payload.error) {
        this.report({
          level: "disabled",
          reason: `主题探测脚本执行失败：${payload.error}`,
        });
        throw new Error(payload.error);
      }
      this.report(evaluateThemeProbe(payload));
      const scheme: "light" | "dark" = payload.scheme === "dark" ? "dark" : "light";
      const vars: Record<string, string> = {};
      for (const [key, raw] of Object.entries(payload.vars ?? {})) {
        if (key.startsWith("--") && typeof raw === "string" && raw.trim()) {
          vars[key] = raw.trim();
        }
      }
      const next: ThemeSnapshot = {
        name: typeof payload.name === "string" && payload.name ? payload.name : scheme,
        scheme,
        vars,
        fromPage: payload.fromPage === true && Object.keys(vars).length >= 3,
      };
      if (!next.fromPage) return false;

      const changed = JSON.stringify(next) !== JSON.stringify(this.currentTheme);
      if (changed) {
        this.currentTheme = next;
        this.persist(next);
        if (debug) {
          this.options.onDebug?.(
            `[theme] 切换为 ${next.name}（${next.scheme}，来自页面 ${Object.keys(vars).length} 个变量，已缓存）`,
          );
        }
      }
      return changed;
    } catch (error) {
      // 脚本已经报过 disabled 时不覆盖成 degraded；其它失败保留当前主题缓存
      if (this.lastLevel !== "disabled") {
        this.report({
          level: "degraded",
          reason: `主题探测失败，保留当前主题缓存：${String(error)}`,
        });
      }
      if (debug) {
        const simple = await active
          .executeJavaScript("1 + 1", true)
          .then((v) => `executeJavaScript 可用（1+1=${v}）`)
          .catch((e: unknown) => `连 1+1 都失败：${String(e)}`);
        this.options.onDebug?.(`[theme] 读取失败：${String(error)}；${simple}`);
      }
      return false;
    }
  }
}
