import { nativeImage, type BrowserWindow } from "electron";
import { windowIconPath } from "./assets";

/** 窗口创建后再显式设一次图标，保证任务栏 / Alt+Tab 用应用图标而不是可执行文件的默认图标 */
export function applyWindowIcon(win: BrowserWindow): void {
  const file = windowIconPath();
  if (!file) return;
  try {
    win.setIcon(nativeImage.createFromPath(file));
  } catch {
    // 图标加载失败时保留可执行文件图标，不影响功能
  }
}
