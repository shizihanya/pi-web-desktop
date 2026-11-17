import { readdirSync, readFileSync, unlinkSync, watch, type FSWatcher } from "node:fs";
import { join } from "node:path";

function startMenuProgramsDir(): string | null {
  if (process.platform !== "win32" || !process.env.APPDATA) return null;
  return join(process.env.APPDATA, "Microsoft", "Windows", "Start Menu", "Programs");
}

/**
 * 清理 Electron 自动生成的开始菜单快捷方式。
 *
 * Windows 上只要显示过一次 toast 通知，Electron 就会为进程的 AUMID 自动创建一个
 * `Electron.lnk`：带同 AUMID、图标为空（回落到 electron.exe 的原子图标）。
 * 任务栏按 AUMID 解析到它时会覆盖窗口 icon，于是「托盘是 π、任务栏却是原子」。
 *
 * 只删「内容里带本应用 AUMID 且不是标准快捷方式」的 .lnk，不碰其它应用。
 */
export function removeAutoShortcuts(appId: string, keepName = "Pi Web Desktop.lnk"): string[] {
  const dir = startMenuProgramsDir();
  if (!dir) return [];
  const needle = Buffer.from(appId, "utf16le");
  const removed: string[] = [];
  try {
    for (const name of readdirSync(dir)) {
      if (!name.toLowerCase().endsWith(".lnk") || name === keepName) continue;
      const file = join(dir, name);
      try {
        if (!readFileSync(file).includes(needle)) continue;
        unlinkSync(file);
        removed.push(name);
      } catch {
        // 单个文件被占用或读取失败时跳过
      }
    }
  } catch {
    // 开始菜单目录不存在
  }
  return removed;
}

export interface AutoShortcutWatcher {
  close(): void;
}

/**
 * 监听开始菜单目录：Electron 一弹 toast 就会写 Electron.lnk（带本应用 AUMID、图标为空）。
 * 延迟 500ms 再删：既让 Windows 有时间把通知显示出来，又不让原子图标长时间顶掉任务栏图标。
 * 只删带本应用 AUMID 且不是标准快捷方式的 .lnk。
 */
export function watchAutoShortcuts(
  appId: string,
  onRemoved?: (removed: string[]) => void,
  keepName = "Pi Web Desktop.lnk",
): AutoShortcutWatcher | null {
  const dir = startMenuProgramsDir();
  if (!dir) return null;
  let timer: NodeJS.Timeout | null = null;
  let watcher: FSWatcher | null = null;
  const clean = (): void => {
    const removed = removeAutoShortcuts(appId, keepName);
    if (removed.length) onRemoved?.(removed);
  };
  try {
    watcher = watch(dir, (_event, filename) => {
      if (filename && !filename.toString().toLowerCase().endsWith(".lnk")) return;
      if (timer) clearTimeout(timer);
      timer = setTimeout(clean, 500);
      timer.unref?.();
    });
  } catch {
    watcher = null;
  }
  return {
    close(): void {
      if (timer) clearTimeout(timer);
      timer = null;
      watcher?.close();
      watcher = null;
    },
  };
}
