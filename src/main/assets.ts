import { app } from "electron";
import { existsSync } from "node:fs";
import { join } from "node:path";

/** 图标查找顺序：打包后的 resources → 项目 build 目录 */
function findIcon(name: string): string | null {
  const candidates = [
    join(process.resourcesPath ?? "", name),
    join(app.getAppPath(), "build", name),
    join(__dirname, "../../build", name),
  ];
  return candidates.find((candidate) => candidate && existsSync(candidate)) ?? null;
}

/** 窗口图标：Windows 用多尺寸 ICO，任务栏 / Alt+Tab 会按尺寸挑最清晰的一张 */
export function windowIconPath(): string | null {
  if (process.platform === "win32") {
    const ico = findIcon("icon.ico");
    if (ico) return ico;
  }
  return findIcon("icon.png");
}

/** 托盘小图（32px），找不到时回落到窗口 PNG */
export function trayIconPath(): string | null {
  return findIcon("tray.png") ?? findIcon("icon.png");
}
