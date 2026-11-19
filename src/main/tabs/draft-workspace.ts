/**
 * 独立输入工作区的编排（不 import electron 运行时，可在 check:draft-workspace 里 mock 回归）。
 *
 * 职责边界：
 *  - 面板开合 / 宽度 / 草稿读写 / 页签与会话隔离 / 兼容性结论 / 发送闸门 都在这一层；
 *  - 页面 realm 只跑「只读探针 + 复用原生提交按钮」两类脚本（composer-bridge.ts），
 *    不再注入任何可见按钮或常驻定时器；唯一入口是页签栏工具区的 `⌗` 按钮；
 *  - 绝不自行调用 Agent API，绝不维护第二套发送状态机；
 *  - 主窗口布局只通过 tabs.setReservedRightWidth() 让出空间，不改 pi-web DOM / TabManager 结构。
 */

import { randomUUID } from "node:crypto";
import {
  COMPOSER_PROBE_SCRIPT,
  buildComposerSendScript,
  buildOpenInNativeScript,
  type ComposerImage,
  type ComposerMode,
  type ComposerProbeResult,
  type ComposerSendResult,
} from "./composer-bridge.ts";
import { evaluateComposer, type CompatVerdict } from "./compat.ts";
import {
  DRAFT_MAX_IMAGES,
  DRAFT_MAX_IMAGE_BYTES,
  DRAFT_MIN_WIDTH,
  DRAFT_MAX_WIDTH,
  DRAFT_PANEL_WIDTH,
  DraftStore,
  SendGate,
  clampPanelWidth,
  draftKey,
  matchPersistedDrafts,
  verifyDraftTarget,
  type DraftContext,
  type DraftTarget,
} from "./draft-model.ts";
import { loadDrafts, loadPanelWidth, saveDrafts } from "./draft-persistence.ts";
import type {
  DraftAttachment,
  DraftImageData,
  DraftModes,
  DraftSendResult,
  DraftSnapshot,
  DraftTypography,
} from "../../shared/types.ts";

export { DRAFT_PANEL_WIDTH, DRAFT_MIN_WIDTH, DRAFT_MAX_WIDTH };

/** 与 ThemeContents 同款的最小结构面，Electron WebContents 天然满足，Node 里可 mock */
export interface DraftContents {
  isDestroyed(): boolean;
  executeJavaScript(code: string, userGesture?: boolean): Promise<unknown>;
  on(event: string, listener: (...args: any[]) => void): unknown;
  off(event: string, listener: (...args: any[]) => void): unknown;
}

export interface DraftTabProvider {
  activeTabId(): string | null;
  tabContext(tabId: string): DraftContext | null;
  allContexts(): DraftContext[];
  contents(tabId: string): DraftContents | null;
  setReservedRightWidth(px: number): void;
  /** 窗口内容区宽度，用于把拖出来的面板宽度钳到合理范围 */
  windowWidth(): number;
}

export interface DraftWorkspaceOptions {
  enabled: boolean;
  dataDir: string;
  tabs: DraftTabProvider;
  onChange(snapshot: DraftSnapshot): void;
  /** 转发给 TabManager 的 CompatibilityTracker，复用 [compat] 日志 */
  onCompat(verdict: CompatVerdict): void;
  onDebug?(message: string): void;
}

interface AttachEntry {
  ready: () => void;
}

interface DraftMeta {
  path: string;
  sessionKey: string;
  updatedAt: number;
}

interface StoredImage extends ComposerImage {
  id: string;
  size: number;
}

const EMPTY_MODES: DraftModes = { send: false, steer: false, followUp: false, attach: false };

function parseJson<T>(raw: unknown): T | null {
  if (typeof raw !== "string") return null;
  try {
    const parsed = JSON.parse(raw) as T;
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch {
    return null;
  }
}

export class DraftWorkspace {
  private readonly store = new DraftStore();
  private readonly gate = new SendGate();
  private readonly meta = new Map<string, DraftMeta>();
  private readonly images = new Map<string, StoredImage[]>();
  private readonly attached = new Map<DraftContents, AttachEntry>();
  private readonly options: DraftWorkspaceOptions;

  private panelOpen = false;
  private panelWidth = DRAFT_PANEL_WIDTH;
  private typography: DraftTypography | null = null;
  private modes: DraftModes = { ...EMPTY_MODES };
  private sending = false;
  private compat: CompatVerdict;
  private activeContext: DraftContext | null = null;
  private contextSignature = "";
  private lastResult: DraftSendResult | null = null;
  private appliedWidth = -1;
  private disposed = false;

  constructor(options: DraftWorkspaceOptions) {
    this.options = options;
    const savedWidth = loadPanelWidth(options.dataDir);
    if (savedWidth) this.panelWidth = clampPanelWidth(savedWidth, options.tabs.windowWidth());
    this.compat = evaluateComposer(null, { enabled: options.enabled });
    this.options.onCompat(this.compat);
    this.refreshContext();
    this.emit();
  }

  /* ------------------------------ 面板 ------------------------------ */

  open(): void {
    if (!this.options.enabled || this.panelOpen) return;
    this.panelOpen = true;
    this.lastResult = null;
    this.options.onDebug?.("[draft] 独立输入工作区已展开");
    this.emit();
  }

  /** 收起不丢草稿：草稿一直存在内存 + drafts.json 里 */
  close(): void {
    if (!this.panelOpen) return;
    this.panelOpen = false;
    this.options.onDebug?.("[draft] 独立输入工作区已收起（草稿保留）");
    this.emit();
  }

  toggle(): void {
    if (this.panelOpen) this.close();
    else this.open();
  }

  /** 拖动分隔条：宽度钳到 [min, min(max, 60% 窗口宽)]，并同步给 pi-web 视图让出空间 */
  setWidth(px: number): void {
    const next = clampPanelWidth(px, this.options.tabs.windowWidth());
    if (next === this.panelWidth) return;
    this.panelWidth = next;
    this.persist();
    this.emit();
  }

  /**
   * 自动提交模式：对齐 pi-web 原生 Enter 键的行为（bundle 里 tY 的分支）。
   * 空闲 → send；Agent 运行中优先 steer（立即引导），只有 steer 不可用时才 followUp（排队）。
   * 主按钮每次 render 都按这个结果显示文案，用户不需要手动选。
   */
  autoMode(): ComposerMode {
    if (this.modes.send) return "send";
    if (this.modes.steer) return "steer";
    if (this.modes.followUp) return "followUp";
    return "send";
  }

  /* ------------------------------ 草稿 ------------------------------ */

  setText(text: string): void {
    const ctx = this.activeContext;
    if (!ctx) return;
    // 用户又开始编辑：清掉上一次的成功/失败提示，别让它一直挂在底部
    this.lastResult = null;
    const key = draftKey(ctx);
    this.store.set(ctx, text);
    if (text) this.meta.set(key, { path: ctx.path, sessionKey: ctx.sessionKey, updatedAt: Date.now() });
    else this.meta.delete(key);
    this.persist();
    this.emit();
  }

  /** 面板里粘贴 / 拖入的图片：只存内存，不写进 drafts.json（避免文件膨胀） */
  addImages(list: ComposerImage[]): void {
    const ctx = this.activeContext;
    if (!ctx) return;
    const key = draftKey(ctx);
    const current = this.images.get(key) ?? [];
    for (const image of list) {
      if (current.length >= DRAFT_MAX_IMAGES) break;
      if (!image || typeof image.data !== "string" || !image.mimeType.startsWith("image/")) continue;
      // base64 解码后约 3/4 字节，简单按字符数估一下上限
      if (image.data.length * 0.75 > DRAFT_MAX_IMAGE_BYTES) continue;
      current.push({
        id: randomUUID(),
        data: image.data,
        mimeType: image.mimeType,
        name: image.name || "image.png",
        size: Math.round(image.data.length * 0.75),
      });
    }
    this.images.set(key, current);
    this.emit();
  }

  removeImage(id: string): void {
    for (const [key, list] of this.images) {
      const next = list.filter((image) => image.id !== id);
      if (next.length !== list.length) this.images.set(key, next);
    }
    this.emit();
  }

  /** 点击附件 chip 时按需取回，用于面板内大图预览 */
  getImage(id: string): DraftImageData | null {
    for (const list of this.images.values()) {
      const found = list.find((image) => image.id === id);
      if (found) return { data: found.data, mimeType: found.mimeType, name: found.name };
    }
    return null;
  }

  private imagesFor(target: DraftTarget): ComposerImage[] {
    return (this.images.get(draftKey(target)) ?? []).map(({ data, mimeType, name }) => ({
      data,
      mimeType,
      name,
    }));
  }

  private attachmentsFor(target: DraftTarget): DraftAttachment[] {
    return (this.images.get(draftKey(target)) ?? []).map(({ id, name, mimeType, size }) => ({
      id,
      name,
      mimeType,
      size,
    }));
  }

  /** 重启恢复：页签 id 会变，按 path + sessionKey 一对一匹配 */
  hydrate(contexts: DraftContext[]): void {
    const persisted = loadDrafts(this.options.dataDir);
    const matched = matchPersistedDrafts(contexts, persisted);
    this.store.hydrate(matched);
    for (const ctx of contexts) {
      if (matched.some((item) => item.key === draftKey(ctx))) {
        this.meta.set(draftKey(ctx), {
          path: ctx.path,
          sessionKey: ctx.sessionKey,
          updatedAt: Date.now(),
        });
      }
    }
    this.options.onDebug?.(`[draft] 重启恢复 ${matched.length} 条草稿`);
    this.emit();
  }

  /* ------------------------------ 发送 ------------------------------ */

  /** 模式完全自动，不接受外部指定，避免把旧会话草稿按错误模式发出去 */
  async send(): Promise<DraftSendResult> {
    const mode = this.autoMode();
    const ctx = this.activeContext;
    const expected: DraftTarget | null = ctx ? { tabId: ctx.tabId, sessionKey: ctx.sessionKey } : null;
    if (!expected) return this.fail("当前没有可用的页签");
    const text = this.store.get(expected);
    const images = this.imagesFor(expected);
    if (!text.trim() && images.length === 0) return this.fail("草稿为空");

    // 发送前复核：目标页签仍在、会话没变（did-navigate-in-page 可能已经换会话）
    const check = verifyDraftTarget(this.liveTarget(), expected);
    if (!check.ok) return this.fail(check.reason);
    if (!this.options.enabled) return this.fail("独立输入工作区已关闭，请使用 pi-web 原生输入框");
    if (this.compat.level === "disabled") {
      return this.fail(`已禁止发送：${this.compat.reason}`);
    }
    if (this.compat.level === "unverified") {
      return this.fail("Composer 兼容性尚未确认，已禁止发送（草稿保留）");
    }

    const key = draftKey(expected);
    // 连续快速点击：同一草稿在结果回来前只允许一次提交
    if (!this.gate.begin(key)) return this.fail("上一次发送尚未结束，已忽略重复点击");
    this.sending = true;
    this.lastResult = null;
    this.emit();
    try {
      const wc = this.options.tabs.contents(expected.tabId);
      if (!wc || wc.isDestroyed()) return this.fail("目标页签已不可用（草稿保留）");
      const raw = await wc.executeJavaScript(
        buildComposerSendScript({ text, sessionKey: expected.sessionKey, mode, images }),
        true,
      );
      const result = parseJson<ComposerSendResult>(raw);
      if (!result || typeof result.ok !== "boolean") {
        return this.fail("原生发送脚本没有返回有效结果（草稿保留）");
      }
      if (result.ok) {
        this.store.clear(expected);
        this.meta.delete(key);
        this.images.delete(key);
        this.persist();
        this.options.onDebug?.(`[draft] 发送成功（${mode}），已清空本次草稿与附件`);
      } else {
        // 失败保留草稿：绝不因为一次失败就把用户写的长文本 / 图片丢掉
        this.options.onDebug?.(`[draft] 发送失败，草稿保留：${result.reason}`);
      }
      this.lastResult = { ok: result.ok, reason: result.reason };
      this.emit();
      return this.lastResult;
    } catch (error) {
      return this.fail(`注入发送异常：${String(error)}（草稿保留）`);
    } finally {
      this.gate.end(key);
      this.sending = false;
      this.emit();
    }
  }

  /**
   * 「在原生输入框中继续」：把草稿 + 图片交给原生 Composer 并把焦点给它。
   * 之后用户可以原生能力（@ 文件提及、/ 命令、模型、工具、steer/next）继续编辑并自己发送。
   */
  async openInNative(): Promise<DraftSendResult> {
    const ctx = this.activeContext;
    if (!ctx) return this.fail("当前没有可用的页签");
    const expected: DraftTarget = { tabId: ctx.tabId, sessionKey: ctx.sessionKey };
    const check = verifyDraftTarget(this.liveTarget(), expected);
    if (!check.ok) return this.fail(check.reason);
    const wc = this.options.tabs.contents(expected.tabId);
    if (!wc || wc.isDestroyed()) return this.fail("目标页签已不可用");
    try {
      const raw = await wc.executeJavaScript(
        buildOpenInNativeScript({
          text: this.store.get(expected),
          sessionKey: expected.sessionKey,
          mode: this.autoMode(),
          images: this.imagesFor(expected),
        }),
        true,
      );
      const result = parseJson<ComposerSendResult>(raw);
      if (!result) return this.fail("原生输入框没有返回结果");
      if (result.ok) {
        const key = draftKey(expected);
        this.store.clear(expected);
        this.meta.delete(key);
        this.images.delete(key);
        this.persist();
        this.close();
      }
      this.lastResult = result;
      this.emit();
      return result;
    } catch (error) {
      return this.fail(`放入原生输入框失败：${String(error)}（草稿保留）`);
    }
  }

  /* --------------------------- 页签生命周期 --------------------------- */

  /** 只保留只读探针的重装：不再往 pi-web 页面注入任何可见按钮 / console 信号 */
  attach(wc: DraftContents): void {
    if (!this.options.enabled || this.disposed || this.attached.has(wc) || wc.isDestroyed()) return;
    const ready = (): void => {
      if (wc.isDestroyed()) return;
      void this.probeActive();
    };
    wc.on("dom-ready", ready);
    wc.on("did-finish-load", ready);
    this.attached.set(wc, { ready });
  }

  detach(wc: DraftContents): void {
    const entry = this.attached.get(wc);
    if (!entry) return;
    try {
      wc.off("dom-ready", entry.ready);
      wc.off("did-finish-load", entry.ready);
    } catch {
      // WebContents 可能已经销毁
    }
    this.attached.delete(wc);
  }

  detachAll(): void {
    for (const wc of [...this.attached.keys()]) this.detach(wc);
  }

  onTabClosed(tabId: string): void {
    this.store.clearTab(tabId);
    for (const key of [...this.meta.keys()]) {
      if (key.startsWith(`${tabId}::`)) this.meta.delete(key);
    }
    for (const key of [...this.images.keys()]) {
      if (key.startsWith(`${tabId}::`)) this.images.delete(key);
    }
    this.persist();
    this.refreshContext();
  }

  /** 页签切换 / 会话切换 / 分屏焦点变化后由 TabManager.notify() 触发 */
  refreshContext(): void {
    const id = this.options.tabs.activeTabId();
    const ctx = id ? this.options.tabs.tabContext(id) : null;
    const signature = ctx ? `${ctx.tabId}::${ctx.sessionKey}` : "";
    const changed = signature !== this.contextSignature;
    const titleChanged = (ctx?.title ?? "") !== (this.activeContext?.title ?? "");
    // 存副本：provider 返回的对象可能被就地修改，不能让 activeContext 跟着变
    this.activeContext = ctx ? { ...ctx } : null;
    if (!changed && !titleChanged) return;
    this.contextSignature = signature;
    if (changed) {
      this.lastResult = null;
      void this.probeActive();
    }
    this.emit();
  }

  /**
   * 服务地址变化导致 TabManager 重建时调用。
   * 注意：这里**不能** detachAll —— init() 里刚通过 onTabCreated 注册好的 dom-ready 监听
   * 会被摘掉，页面 realm 的只读探针就再也装不上（真实 GUI 暴露过）。
   * 旧 WebContents 的监听在 TabManager.destroy() 前由调用方显式 detachAll() 清理。
   */
  onTabsReplaced(): void {
    this.appliedWidth = -1;
    this.contextSignature = "";
    this.activeContext = null;
    this.refreshContext();
    this.applyLayout();
    void this.probeActive();
  }

  dispose(): void {
    this.disposed = true;
    this.detachAll();
  }

  /* ------------------------------ 内部 ------------------------------ */

  snapshot(): DraftSnapshot {
    const ctx = this.activeContext;
    const text = ctx ? this.store.get(ctx) : "";
    const hasContent = text.trim().length > 0 || (ctx ? this.imagesFor(ctx).length > 0 : false);
    const canSend =
      this.options.enabled &&
      !!ctx &&
      !this.sending &&
      hasContent &&
      (this.compat.level === "compatible" || this.compat.level === "degraded");
    return {
      enabled: this.options.enabled,
      open: this.panelOpen,
      panelWidth: this.panelWidth,
      minPanelWidth: DRAFT_MIN_WIDTH,
      maxPanelWidth: DRAFT_MAX_WIDTH,
      typography: this.typography,
      modes: { ...this.modes },
      mode: this.autoMode(),
      attachments: ctx ? this.attachmentsFor(ctx) : [],
      tabId: ctx?.tabId ?? null,
      tabTitle: ctx?.title ?? "",
      sessionKey: ctx?.sessionKey ?? null,
      text,
      compat: { level: this.compat.level, reason: this.compat.reason },
      sending: this.sending,
      canSend,
      lastResult: this.lastResult,
    };
  }

  private fail(reason: string): DraftSendResult {
    this.options.onDebug?.(`[draft] 发送被阻止：${reason}`);
    this.lastResult = { ok: false, reason };
    this.emit();
    return this.lastResult;
  }

  private liveTarget(): DraftTarget | null {
    const id = this.options.tabs.activeTabId();
    const ctx = id ? this.options.tabs.tabContext(id) : null;
    return ctx ? { tabId: ctx.tabId, sessionKey: ctx.sessionKey } : null;
  }

  private setCompat(verdict: CompatVerdict): void {
    if (this.compat.level === verdict.level && this.compat.reason === verdict.reason) return;
    this.compat = verdict;
    this.options.onCompat(verdict);
    this.emit();
  }

  /** 只读探针：拿字体 / 当前可用的原生按钮（自动模式判定） / 兼容性结论 */
  private async probeActive(): Promise<void> {
    const ctx = this.activeContext;
    if (!ctx || !this.options.enabled || this.disposed) return;
    const wc = this.options.tabs.contents(ctx.tabId);
    if (!wc || wc.isDestroyed()) return;
    try {
      const raw = await wc.executeJavaScript(COMPOSER_PROBE_SCRIPT, true);
      const payload = parseJson<ComposerProbeResult>(raw);
      if (!payload) return;
      this.typography = payload.typography ?? null;
      this.modes = { ...EMPTY_MODES, ...(payload.modes ?? {}) };
      // 探针一更新 modes，主按钮文案就通过 emit() 自动跟着切，无需用户操作
      this.setCompat(evaluateComposer(payload, { enabled: this.options.enabled }));
      this.emit();
    } catch (error) {
      this.setCompat({
        level: "disabled",
        reason: `Composer 探针注入失败：${String(error)}（禁止发送，原生输入框不受影响）`,
      });
    }
  }

  private persist(): void {
    const entries = this.store.entries().map(({ key, text }) => {
      const info = this.meta.get(key);
      const separator = key.indexOf("::");
      return {
        key,
        path: info?.path ?? "",
        sessionKey: info?.sessionKey ?? key.slice(separator + 2),
        text,
        updatedAt: info?.updatedAt ?? Date.now(),
      };
    });
    saveDrafts(this.options.dataDir, entries, this.panelWidth);
  }

  private applyLayout(): void {
    const width = this.panelOpen ? this.panelWidth : 0;
    if (width === this.appliedWidth) return;
    this.appliedWidth = width;
    this.options.tabs.setReservedRightWidth(width);
  }

  private emit(): void {
    if (this.disposed) return;
    this.applyLayout();
    this.options.onChange(this.snapshot());
  }
}
