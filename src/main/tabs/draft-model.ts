/**
 * 独立输入工作区：草稿状态（纯逻辑，不 import electron，可被 check:draft-model 直接测试）。
 *
 * 设计要点：
 *  - 草稿 key = 页签 id + 会话 key（session / cwd / new），从根上隔离不同页签、不同会话；
 *  - 会话 key 只从页签 URL（tab.path）解析，不依赖 pi-web 内部状态；
 *  - 发送前用 verifyDraftTarget 复核「目标页签仍对应原来的会话」；
 *  - SendGate 保证连续快速点击不会重复提交。
 */

export interface DraftTarget {
  tabId: string;
  sessionKey: string;
}

export interface DraftContext extends DraftTarget {
  title: string;
  /** 相对服务根的路径，例如 /?session=abc；重启后恢复草稿用它做稳定匹配 */
  path: string;
}

export interface TargetCheck {
  ok: boolean;
  reason: string;
}

/** 新建会话（URL 上既没有 session 也没有 cwd）时用的固定 key */
export const NEW_SESSION_KEY = "new";

/** 右侧独立编辑面板宽度（TabManager 与面板渲染层共用），可拖动调整 */
export const DRAFT_PANEL_WIDTH = 380;
export const DRAFT_MIN_WIDTH = 280;
export const DRAFT_MAX_WIDTH = 720;
/** 图片：对齐 pi-web 自己的上限（slice(0,10)），单张 5MB */
export const DRAFT_MAX_IMAGES = 10;
export const DRAFT_MAX_IMAGE_BYTES = 5 * 1024 * 1024;

export function clampPanelWidth(px: number, windowWidth = 1_440): number {
  const upper = Math.min(DRAFT_MAX_WIDTH, Math.max(DRAFT_MIN_WIDTH, Math.floor(windowWidth * 0.6)));
  if (!Number.isFinite(px)) return DRAFT_PANEL_WIDTH;
  return Math.max(DRAFT_MIN_WIDTH, Math.min(upper, Math.round(px)));
}

/** 从页签路径里解析会话身份；session 优先，其次 cwd，都没有算「新会话」 */
export function sessionKeyFromPath(path: string): string {
  const hash = path.indexOf("#");
  const clean = hash >= 0 ? path.slice(0, hash) : path;
  const mark = clean.indexOf("?");
  const query = mark >= 0 ? clean.slice(mark + 1) : "";
  try {
    const params = new URLSearchParams(query);
    const session = params.get("session");
    if (session) return `session:${session}`;
    const cwd = params.get("cwd");
    if (cwd) return `cwd:${cwd}`;
  } catch {
    // URLSearchParams 基本不会抛；保底走新会话
  }
  return NEW_SESSION_KEY;
}

/** 草稿 key：页签 + 会话双维度 */
export function draftKey(target: DraftTarget): string {
  return `${target.tabId}::${target.sessionKey}`;
}

export function contextKey(context: DraftContext): string {
  return `${context.tabId}::${context.sessionKey}::${context.title}`;
}

/** 发送前复核：页签没关、没切走、会话没变，才允许把草稿发出去 */
export function verifyDraftTarget(current: DraftTarget | null, expected: DraftTarget): TargetCheck {
  if (!current) return { ok: false, reason: "目标页签已关闭，禁止发送草稿" };
  if (current.tabId !== expected.tabId) {
    return { ok: false, reason: "当前页签已切换，禁止把草稿发到别的页签" };
  }
  if (current.sessionKey !== expected.sessionKey) {
    return { ok: false, reason: "当前会话已切换，禁止发送旧会话草稿" };
  }
  return { ok: true, reason: "" };
}

/** 页签 + 会话隔离的内存草稿仓库；空串视为「没有草稿」 */
export class DraftStore {
  private readonly drafts = new Map<string, string>();

  get(target: DraftTarget): string {
    return this.drafts.get(draftKey(target)) ?? "";
  }

  set(target: DraftTarget, text: string): void {
    const key = draftKey(target);
    if (text.length === 0) this.drafts.delete(key);
    else this.drafts.set(key, text);
  }

  clear(target: DraftTarget): void {
    this.drafts.delete(draftKey(target));
  }

  /** 页签关闭：清掉它名下的所有会话草稿 */
  clearTab(tabId: string): void {
    for (const key of [...this.drafts.keys()]) {
      if (key.startsWith(`${tabId}::`)) this.drafts.delete(key);
    }
  }

  hydrate(entries: { key: string; text: string }[]): void {
    for (const entry of entries) {
      if (typeof entry.key === "string" && typeof entry.text === "string" && entry.text) {
        this.drafts.set(entry.key, entry.text);
      }
    }
  }

  entries(): { key: string; text: string }[] {
    return [...this.drafts.entries()].map(([key, text]) => ({ key, text }));
  }

  get size(): number {
    return this.drafts.size;
  }
}

/**
 * 发送闸门：同一个草稿 key 在「结果回来之前」只允许一次提交。
 * 与页面 realm 里的 __piDesktopDraftSending 形成双保险。
 */
export class SendGate {
  private readonly active = new Set<string>();

  begin(key: string): boolean {
    if (this.active.has(key)) return false;
    this.active.add(key);
    return true;
  }

  end(key: string): void {
    this.active.delete(key);
  }

  isActive(key: string): boolean {
    return this.active.has(key);
  }

  get size(): number {
    return this.active.size;
  }
}

/**
 * 把持久化条目按「路径 + 会话」一对一匹配到本次启动的页签。
 * 页签 id 每次启动都会变（randomUUID），所以重启恢复不能按 id 匹配；
 * 每个持久化条目最多只恢复到一个页签，避免同一草稿出现在两个页签里。
 */
export function matchPersistedDrafts(
  contexts: DraftContext[],
  persisted: { path: string; sessionKey: string; text: string }[],
): { key: string; text: string }[] {
  const used = new Set<number>();
  const out: { key: string; text: string }[] = [];
  for (const context of contexts) {
    const index = persisted.findIndex(
      (entry, i) =>
        !used.has(i) && entry.text && entry.path === context.path && entry.sessionKey === context.sessionKey,
    );
    if (index < 0) continue;
    used.add(index);
    out.push({ key: draftKey(context), text: persisted[index].text });
  }
  return out;
}
