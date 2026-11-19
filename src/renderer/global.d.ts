import type { DraftApi, ShellApi, SettingsApi, TabbarApi } from "../shared/types";

declare global {
  interface Window {
    /** splash 页用 */
    piWebShell: ShellApi;
    /** 页签栏用 */
    piWebTabs: TabbarApi;
    /** 设置窗口用 */
    piWebSettings: SettingsApi;
    /** 桌面增强：独立输入工作区面板 */
    piWebDrafts: DraftApi;
  }
}

export {};
