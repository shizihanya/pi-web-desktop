/**
 * 主进程 ↔ 渲染进程共享的类型。
 * 注意：这里只放「序列化友好」的纯数据，不放任何 Node / Electron API。
 */

import type { SplitPreset, SplitSnapshot } from "./split";

export type ServerPhase = "idle" | "resolving" | "starting" | "ready" | "failed";

export interface ServerState {
  phase: ServerPhase;
  /** 服务可用时的地址，例如 http://127.0.0.1:30141 */
  url: string | null;
  port: number | null;
  hostname: string | null;
  /** 是否是本应用拉起的进程（false = 复用了外部已在跑的服务，退出时不能杀） */
  managed: boolean;
  /** pi-web 版本，解析成功后即有 */
  version: string | null;
  /** 失败原因（面向用户的一句话） */
  message: string | null;
  /** 可复制的细节（命令、路径、错误栈尾部） */
  detail: string | null;
}

export interface ShellApi {
  getState(): Promise<ServerState>;
  getLogs(): Promise<string[]>;
  retry(): Promise<ServerState>;
  openLogFile(): Promise<void>;
  openDataFolder(): Promise<void>;
  quit(): Promise<void>;
  /** 服务状态变化（splash 用来更新界面） */
  onState(cb: (state: ServerState) => void): () => void;
  /** 追加的日志行 */
  onLog(cb: (line: string) => void): () => void;
}

export const IPC = {
  getState: "shell:get-state",
  getLogs: "shell:get-logs",
  retry: "shell:retry",
  openLogFile: "shell:open-log",
  openDataFolder: "shell:open-data-folder",
  quit: "shell:quit",
  stateEvent: "shell:state",
  logEvent: "shell:log",
} as const;

/* ------------------------------- 页签 ------------------------------- */

/**
 * 页签上「当前选中的对话」的状态，决定页签名后面显示什么。
 * idle      = 空闲（不显示任何东西）
 * running   = 正在等待回答（转圈）
 * unread    = 回答完毕但还没切到这个页签看过（提示点）
 * awaiting  = 智能体在等你确认（橙色提示点，比未读更急）
 */
export type TabStatus = "idle" | "running" | "unread" | "awaiting";

export interface TabInfo {
  id: string;
  title: string;
  favicon: string | null;
  pinned: boolean;
  loading: boolean;
  status: TabStatus;
  /** 渲染进程崩溃：页签保留、会话 URL 保留，提供显式重新加载入口（可选字段，老数据兼容） */
  crashed?: boolean;
  crashReason?: string | null;
}

export interface ThemeSnapshot {
  /** pi-web 当前主题 id：light / mist / pine / zenburn ... */
  name: string;
  /** 明暗归类，用于 color-scheme 和原生窗口控件 */
  scheme: "light" | "dark";
  /** 从页面 computed style 读到的 CSS 变量，原样透传给页签栏 */
  vars: Record<string, string>;
  /** 是否成功读到页面变量；false 时页签栏用内置明/暗兜底 */
  fromPage: boolean;
}

export interface TabsSnapshot {
  tabs: TabInfo[];
  /** 当前焦点窗格里的页签（单栏时就是唯一显示的页签） */
  activeId: string | null;
  baseUrl: string;
  /** 跟随 pi-web 的实际主题（不只是明/暗） */
  theme: ThemeSnapshot;
  /** 是否启用了自绘标题栏（决定右侧要给窗口控件预留多少空间） */
  customTitleBar: boolean;
  /** 分屏状态：split.groups.length 是窗格数，1 = 没分屏（渲染层走原来的单条页签栏） */
  split: SplitSnapshot;
}

export interface TabbarApi {
  list(): Promise<TabsSnapshot>;
  /** 开新页签（不传则开服务根页） */
  open(path?: string): Promise<void>;
  close(id: string): Promise<void>;
  activate(id: string): Promise<void>;
  move(id: string, index: number): Promise<void>;
  setPinned(id: string, pinned: boolean): Promise<void>;
  showMenu(id: string, x: number, y: number): Promise<void>;
  /** 重新加载崩溃的页签（先验证服务仍可用，再用保存的会话 URL 恢复） */
  reloadCrashed(id: string): Promise<boolean>;
  /** 打开外壳设置窗口（页签栏右侧的设置按钮） */
  openSettings(): Promise<void>;
  /* ---- 分屏（VSCode 式「页签分组」） ---- */
  /** 切换布局预设：单栏 / 左右双栏 / 上下双栏 / 三栏 / 四宫格 */
  setSplit(preset: SplitPreset): Promise<void>;
  /** 右键「在右侧 / 下方分屏显示」：把页签移到旁边的新窗格 */
  splitWith(id: string, orientation?: "columns" | "rows"): Promise<void>;
  /** 焦点切到第 n 个窗格 */
  focusGroup(index: number): Promise<void>;
  /** 关闭第 n 个窗格（页签本身不关闭，合并到相邻窗格） */
  closeGroup(index: number): Promise<void>;
  /** 在第 n 个窗格新建页签 */
  newTabInGroup(index: number): Promise<void>;
  /** 把页签拖到第 n 个窗格；insertIndex 是该组页签条上的插入位置 */
  moveTabToGroup(id: string, groupIndex: number, insertIndex?: number): Promise<void>;
  /** 拖到窗口最左 / 最右：新建一个窗格并放入该页签 */
  splitTabToEdge(id: string, side: "left" | "right"): Promise<void>;
  /** 拖动期间临时隐藏所有内容视图，好让渲染层的投放层露出来 */
  beginTabDrag(): Promise<void>;
  endTabDrag(): Promise<void>;
  /* ---- 分隔条拖动（M2） ---- */
  /** 开始拖某个 SplitNode 的分隔条：期间只更新 bounds / 不写盘 / 不抢焦点 */
  beginSashDrag(splitId: string): Promise<void>;
  /** 拖动中的实时坐标（窗口内容区 DIP）+ 事件时间戳；ratio 由主进程按同一份布局结果换算。
   *  stamp 用来丢弃比主进程轮询更旧的 IPC，避免 ratio 回跳。 */
  setSashRatio(splitId: string, x: number, y: number, stamp: number): Promise<void>;
  /** 松开 / 取消：落盘最终 ratio */
  endSashDrag(): Promise<void>;
  /** 分屏按钮的下拉菜单 */
  showSplitMenu(x: number, y: number): Promise<void>;
  /** 某个窗格的右键/更多菜单：把哪个页签移动到这里 */
  showGroupMenu(index: number, x: number, y: number): Promise<void>;
  onTabs(cb: (snapshot: TabsSnapshot) => void): () => void;
  getServerState(): Promise<ServerState>;
  onServerState(cb: (state: ServerState) => void): () => void;
}

export type { SplitLayout, SplitPreset, SplitSnapshot } from "./split";

/* --------------------- 桌面增强：独立输入工作区 --------------------- */

/** 与 compat.ts 的 CompatLevel 保持一致（这里不 import 主进程模块） */
export type DraftCompatLevel = "compatible" | "degraded" | "unverified" | "disabled";

export type ComposerMode = "send" | "steer" | "followUp";

/** 从 pi-web 原生 textarea 的 computed style 读来，保证面板字体与原生一致 */
export interface DraftTypography {
  fontFamily: string;
  fontSize: string;
  lineHeight: string;
  color: string;
  background: string;
  letterSpacing: string;
}

/** pi-web 当前提供了哪些原生按钮 */
export interface DraftModes {
  send: boolean;
  steer: boolean;
  followUp: boolean;
  attach: boolean;
}

/** 面板里附加的图片（base64 只在主进程内存里，快照只给元数据） */
export interface DraftAttachment {
  id: string;
  name: string;
  mimeType: string;
  size: number;
}

/** 点击附件 chip 时按需取回图片数据（不放在快照里，避免每次 emit 都传大 base64） */
export interface DraftImageData {
  data: string;
  mimeType: string;
  name: string;
}

export interface DraftSnapshot {
  /** 桌面增强是否启用（关闭后 pi-web 原生 Composer 完全不受影响） */
  enabled: boolean;
  /** 右侧编辑面板是否展开 */
  open: boolean;
  /** 面板占用的宽度（主进程据此给 pi-web 视图留出空间，而不是盖住对话） */
  panelWidth: number;
  minPanelWidth: number;
  maxPanelWidth: number;
  /** 跟随原生输入框的字体 / 字号 / 行高 / 颜色 */
  typography: DraftTypography | null;
  /** 当前可用的原生发送模式（Agent 运行时会出现 steer / followUp） */
  modes: DraftModes;
  /** 当前自动判定的提交模式（空闲=send，Agent 运行中=steer/followUp），主按钮据此显示文案 */
  mode: ComposerMode;
  /** 已附加的图片 */
  attachments: DraftAttachment[];
  /** 当前绑定的页签 / 会话；草稿按 tabId + sessionKey 隔离 */
  tabId: string | null;
  tabTitle: string;
  sessionKey: string | null;
  text: string;
  compat: { level: DraftCompatLevel; reason: string };
  sending: boolean;
  canSend: boolean;
  lastResult: DraftSendResult | null;
}

export interface DraftSendResult {
  ok: boolean;
  reason: string;
}

/** 面板渲染层专用的极小 API（不暴露任何 Node / Electron 能力） */
export interface DraftApi {
  get(): Promise<DraftSnapshot>;
  setText(text: string): Promise<void>;
  open(): Promise<void>;
  close(): Promise<void>;
  toggle(): Promise<void>;
  /** 拖动分隔条调整面板宽度 */
  setWidth(px: number): Promise<void>;
  /** 面板里粘贴 / 拖入的图片（base64 不带 data: 前缀） */
  addImages(images: { data: string; mimeType: string; name: string }[]): Promise<void>;
  removeImage(id: string): Promise<void>;
  /** 点击附件时按需取回图片，用于面板内大图预览 */
  getImage(id: string): Promise<DraftImageData | null>;
  /** 把草稿放进原生输入框并把焦点给它，使用原生全部能力继续编辑 */
  openInNative(): Promise<DraftSendResult>;
  /** 提交模式由主进程按 pi-web 当前状态自动决定 */
  send(): Promise<DraftSendResult>;
  onChange(cb: (snapshot: DraftSnapshot) => void): () => void;
}

export const DRAFT_IPC = {
  get: "drafts:get",
  setText: "drafts:set-text",
  open: "drafts:open",
  close: "drafts:close",
  toggle: "drafts:toggle",
  setWidth: "drafts:set-width",
  addImages: "drafts:add-images",
  removeImage: "drafts:remove-image",
  getImage: "drafts:get-image",
  openInNative: "drafts:open-in-native",
  send: "drafts:send",
  changedEvent: "drafts:changed",
} as const;

export const TAB_IPC = {
  list: "tabs:list",
  open: "tabs:open",
  close: "tabs:close",
  activate: "tabs:activate",
  move: "tabs:move",
  setPinned: "tabs:set-pinned",
  showMenu: "tabs:menu",
  reloadCrashed: "tabs:reload-crashed",
  openSettings: "tabs:open-settings",
  changedEvent: "tabs:changed",
  setSplit: "tabs:set-split",
  splitWith: "tabs:split-with",
  focusGroup: "tabs:focus-group",
  closeGroup: "tabs:close-group",
  newTabInGroup: "tabs:new-tab-in-group",
  moveTabToGroup: "tabs:move-tab-to-group",
  splitTabToEdge: "tabs:split-tab-to-edge",
  beginTabDrag: "tabs:begin-tab-drag",
  endTabDrag: "tabs:end-tab-drag",
  beginSashDrag: "tabs:begin-sash-drag",
  setSashRatio: "tabs:set-sash-ratio",
  endSashDrag: "tabs:end-sash-drag",
  showSplitMenu: "tabs:split-menu",
  showGroupMenu: "tabs:group-menu",
} as const;

/* ------------------------------- 设置 ------------------------------- */

export interface LanAddress {
  name: string;
  address: string;
  url: string;
}

export interface ResolvedPiWeb {
  nodePath: string;
  nodeVersion: string;
  scriptPath: string;
  version: string;
}

export interface SettingsView {
  port: number;
  portFallbackRange: [number, number];
  closeBehavior: "tray" | "quit";
  launchAtLogin: boolean;
  restoreTabs: boolean;
  alwaysOnTop: boolean;
  remoteAccessEnabled: boolean;
  hasPassword: boolean;
  piWebScriptPath: string | null;
  nodePath: string | null;
  resolved: ResolvedPiWeb | null;
  server: ServerState;
  lanAddresses: LanAddress[];
  /** 绿色版不支持/不推荐开机自启（路径会变） */
  portable: boolean;
  dataDir: string;
}

export interface SettingsPatch {
  port?: number;
  closeBehavior?: "tray" | "quit";
  launchAtLogin?: boolean;
  restoreTabs?: boolean;
  alwaysOnTop?: boolean;
  /** password 为空字符串表示不修改；传 null 表示清空 */
  remoteAccess?: { enabled: boolean; password?: string | null };
  piWebScriptPath?: string | null;
  nodePath?: string | null;
}

export interface SaveResult {
  ok: boolean;
  message?: string;
  needsRestart: boolean;
  view: SettingsView;
}

/* --------------------------- pi-web 更新 --------------------------- */

export type PiWebUpdatePhase =
  | "checking"
  | "stopping"
  | "installing"
  | "restarting"
  | "up-to-date"
  | "done"
  | "failed";

export interface PiWebUpdateProgress {
  phase: PiWebUpdatePhase;
  message: string;
  /** npm 输出的一行（只用于设置页滚动日志） */
  log?: string;
  current?: string | null;
  latest?: string | null;
  installed?: string | null;
}

export type PiWebUpdateStatus = "up-to-date" | "updated" | "failed";

export interface PiWebUpdateResult {
  ok: boolean;
  status: PiWebUpdateStatus;
  message: string;
  current: string | null;
  latest: string | null;
  installed: string | null;
  view: SettingsView;
}

export interface SettingsApi {
  load(): Promise<SettingsView>;
  save(patch: SettingsPatch): Promise<SaveResult>;
  /** 保存并重启服务（端口/远程访问/路径变更时用） */
  saveAndRestart(patch: SettingsPatch): Promise<SaveResult>;
  generatePassword(): Promise<string>;
  refreshLan(): Promise<LanAddress[]>;
  copy(text: string): Promise<void>;
  close(): Promise<void>;
  /** 检查 pi-web 更新；有新版本时：停服务 → npm 全局更新 → 重启服务 */
  updatePiWeb(): Promise<PiWebUpdateResult>;
  /** 更新流程的实时进度 / npm 输出 */
  onPiWebUpdate(cb: (progress: PiWebUpdateProgress) => void): () => void;
}

export const SETTINGS_IPC = {
  load: "settings:load",
  save: "settings:save",
  saveAndRestart: "settings:save-restart",
  generatePassword: "settings:generate-password",
  refreshLan: "settings:lan",
  copy: "settings:copy",
  close: "settings:close",
  updatePiWeb: "settings:piweb-update",
  piWebUpdateEvent: "settings:piweb-update-event",
} as const;
