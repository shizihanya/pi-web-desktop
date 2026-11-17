import type { ShellApi, SettingsApi, TabbarApi } from "../shared/types";

declare global {
  interface Window {
    /** splash 页用 */
    piWebShell: ShellApi;
    /** 页签栏用 */
    piWebTabs: TabbarApi;
    /** 设置窗口用 */
    piWebSettings: SettingsApi;
  }
}

export {};
