/**
 * TabStatusManager（第三阶段：把「状态探测与状态计算」从 TabManager 抽出）。
 *
 * 职责边界（刻意保持很小，不做通用 Adapter 框架）：
 *  - 选一个有效页面作为全局状态请求源，每轮只发一次 /api/agent/running；
 *  - 把同一份 GlobalStatusSnapshot 套用到每个页签自己的 sessionId；
 *  - 接口失败保留最后一次有效状态、无依据时 unknown 保留上一轮；
 *  - 源关闭 / 连续失败后自动换源；服务重启后 reset() 重新初始化。
 *
 * 不依赖 electron：StatusSource 是结构接口，可以用 mock WebContents 在 Node 里
 * 完整回归（scripts/check-tab-status-manager.mjs）。
 * TabManager 仍负责：定时器、把 probe 落到页签栏状态、notify / 持久化。
 */

// 显式 .ts 扩展名：Node 的 --experimental-strip-types 需要它，
// electron-vite / esbuild 同样能解析（tsconfig 已开 allowImportingTsExtensions）。
import {
  GLOBAL_STATUS_READ_SCRIPT,
  TAB_SESSION_READ_SCRIPT,
  type GlobalStatusSnapshot,
  type TabSessionProbe,
  type TabStatusProbe,
} from "./tab-status.ts";
import { computeTabActivity, parseGlobalStatus, parseTabSession } from "./status-model.ts";
import { evaluateStatusProbe, type CompatVerdict } from "./compat.ts";

/** 状态源连续失败多少次后换一个页面（换源在下一轮，本轮不重试，避免 N 份请求） */
export const STATUS_SOURCE_MAX_FAILURES = 3;

export interface StatusSource {
  /** 页签 id，仅用于换源，不含业务语义 */
  key: string;
  /** 上一轮状态：unknown 时要靠它保留，绝不把未知当 idle */
  running: boolean;
  awaiting: boolean;
  isDestroyed(): boolean;
  executeJavaScript(code: string, userGesture?: boolean): Promise<unknown>;
}

export interface TabStatusHost {
  /** 当前所有页签（顺序用于换源） */
  sources(): StatusSource[];
  /** 当前激活页签 id；换源时优先它 */
  activeSourceKey(): string | null;
  /** 把一个页签的折算结果落地；返回是否变化（用于决定是否 notify） */
  onProbe(key: string, probe: TabStatusProbe): boolean;
  onChanged(): void;
  onCompatibility(verdict: CompatVerdict): void;
}

export class TabStatusManager {
  private snapshot: GlobalStatusSnapshot | null = null;
  private sourceKey: string | null = null;
  private failures = 0;
  private issue: string | null = null;
  private lastSession: TabSessionProbe | null = null;
  private polling = false;

  private readonly host: TabStatusHost;

  constructor(host: TabStatusHost) {
    this.host = host;
  }

  /** 当前共享的全局快照（诊断 / 测试用） */
  get currentSnapshot(): GlobalStatusSnapshot | null {
    return this.snapshot;
  }

  /** 当前承担请求的页签（诊断 / 测试用） */
  get currentSourceKey(): string | null {
    return this.sourceKey;
  }

  /** 源页签被关闭：下一轮自动选别人 */
  noteSourceClosed(key: string): void {
    if (this.sourceKey !== key) return;
    this.sourceKey = null;
    this.failures = 0;
  }

  /** 服务重启 / 全局刷新：页面 realm 重建，快照与请求源重新初始化 */
  reset(): void {
    this.snapshot = null;
    this.sourceKey = null;
    this.failures = 0;
    this.issue = null;
    this.lastSession = null;
    this.host.onCompatibility({
      level: "unverified",
      reason: "服务重启，等待重新初始化全局状态",
    });
  }

  /**
   * 一轮轮询：1 次全局请求 + 每个页签 1 次只读会话读取。
   * 只在状态真的变化时 onChanged()，避免页签栏反复重绘、反复写 tabs.json。
   */
  async refresh(): Promise<void> {
    if (this.polling) return;
    this.polling = true;
    let changed = false;
    try {
      const snapshot = await this.readGlobalStatus();
      for (const source of this.host.sources()) {
        if (source.isDestroyed()) continue;
        let session: TabSessionProbe | null = null;
        try {
          const raw = await source.executeJavaScript(TAB_SESSION_READ_SCRIPT, true);
          session = typeof raw === "string" ? parseTabSession(JSON.parse(raw)) : null;
        } catch {
          // 页面还在加载 / 正在导航：保留上一轮状态，不让指示器闪一下
          continue;
        }
        if (!session) continue;
        this.lastSession = session;
        const activity = computeTabActivity(snapshot, session, source);
        if (activity.unknown) continue;
        const probe: TabStatusProbe = {
          sessionId: session.sessionId,
          sessionSource: session.sessionSource,
          running: activity.running,
          awaiting: activity.awaiting,
          ready: snapshot?.ready ?? false,
        };
        changed = this.host.onProbe(source.key, probe) || changed;
      }
      this.host.onCompatibility(
        this.issue
          ? { level: "degraded", reason: this.issue }
          : evaluateStatusProbe(snapshot, this.lastSession),
      );
    } finally {
      this.polling = false;
    }
    if (changed) this.host.onChanged();
  }

  /** 选一个有效页面；源关闭 / 连续失败后自动切到别的页面 */
  private pickSource(sources: StatusSource[]): StatusSource | null {
    const alive = (source: StatusSource | undefined): source is StatusSource =>
      !!source && !source.isDestroyed();
    const current = sources.find((source) => source.key === this.sourceKey);
    if (alive(current) && this.failures < STATUS_SOURCE_MAX_FAILURES) return current;
    const activeKey = this.host.activeSourceKey();
    const active = sources.find((source) => source.key === activeKey);
    const next =
      (alive(active) && active !== current ? active : undefined) ??
      sources.find((source) => alive(source) && source !== current) ??
      (alive(current) ? current : undefined);
    this.sourceKey = next?.key ?? null;
    this.failures = 0;
    return next ?? null;
  }

  /** 一轮只执行一次 /api/agent/running；失败保留最后一次有效快照、不清空状态 */
  private async readGlobalStatus(): Promise<GlobalStatusSnapshot | null> {
    const sources = this.host.sources();
    const source = this.pickSource(sources);
    if (!source) {
      this.issue = "没有可用的页面作为状态请求源，沿用最后一次有效快照";
      return this.snapshot;
    }
    try {
      const raw = await source.executeJavaScript(GLOBAL_STATUS_READ_SCRIPT, true);
      const parsed = typeof raw === "string" ? parseGlobalStatus(JSON.parse(raw)) : null;
      if (!parsed) throw new Error("全局状态脚本未安装或返回结构不符");
      this.failures = 0;
      this.issue = null;
      // 页面侧失败 / 结构异常时保留最后一次有效数组，只把 ok 置 false。
      // 直接采用 parsed：既保留状态（不当成 idle），又让 compat 如实报 degraded。
      if (parsed.ready) this.snapshot = parsed;
      else if (!this.snapshot) this.snapshot = parsed;
      return this.snapshot;
    } catch {
      // 连续失败就换源；本轮不重试其它页面，避免一轮里发出 N 份重复请求
      this.failures += 1;
      this.issue = "全局状态读取失败 / 返回结构不符，沿用最后一次有效快照";
      return this.snapshot;
    }
  }
}
