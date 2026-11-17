import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ThemeSnapshot } from "../../shared/types";

/**
 * 缓存「上次成功探测到的 pi-web 主题」，用于消除冷启动那一下浅色闪屏。
 * 只存纯数据，不含任何 Electron / Node API。
 */
const FILE = "theme.json";
const VERSION = 1;
const MAX_VARS = 32;
const MAX_KEY_LENGTH = 64;
const MAX_VALUE_LENGTH = 200;

export interface PersistedTheme {
  version: number;
  theme: ThemeSnapshot;
}

function themeFile(dataDir: string): string {
  return join(dataDir, FILE);
}

/** 把从页面读到的变量做一次清洗：本地文件被改坏/被塞奇怪内容时也不会污染渲染层 */
function sanitize(input: unknown): ThemeSnapshot | null {
  if (!input || typeof input !== "object") return null;
  const raw = input as Partial<ThemeSnapshot>;
  if (raw.scheme !== "light" && raw.scheme !== "dark") return null;
  if (typeof raw.name !== "string" || !raw.name || raw.name.length > MAX_KEY_LENGTH) return null;
  if (typeof raw.fromPage !== "boolean") return null;

  const vars: Record<string, string> = {};
  if (raw.vars && typeof raw.vars === "object") {
    for (const [key, value] of Object.entries(raw.vars)) {
      if (!key.startsWith("--") || key.length > MAX_KEY_LENGTH) continue;
      if (typeof value !== "string") continue;
      const trimmed = value.trim();
      // 拒绝换行 / 分号 / 花括号，避免写进 :root 内联样式时越界
      if (!trimmed || trimmed.length > MAX_VALUE_LENGTH || /[\r\n;{}]/.test(trimmed)) continue;
      vars[key] = trimmed;
      if (Object.keys(vars).length >= MAX_VARS) break;
    }
  }

  const fromPage = raw.fromPage && Object.keys(vars).length >= 3;
  // 变量不足时按「没有缓存」处理，别把残缺/可疑的主题名和变量带进渲染层
  return fromPage
    ? { name: raw.name, scheme: raw.scheme, vars, fromPage: true }
    : { name: raw.scheme, scheme: raw.scheme, vars: {}, fromPage: false };
}

export function loadTheme(dataDir: string): ThemeSnapshot | null {
  const file = themeFile(dataDir);
  if (!existsSync(file)) return null;
  try {
    const raw = JSON.parse(readFileSync(file, "utf8")) as Partial<PersistedTheme>;
    if (raw.version !== VERSION) return null;
    return sanitize(raw.theme);
  } catch {
    return null;
  }
}

export function saveTheme(dataDir: string, theme: ThemeSnapshot): void {
  if (!theme.fromPage) return;
  const file = themeFile(dataDir);
  const temp = `${file}.tmp`;
  try {
    writeFileSync(temp, `${JSON.stringify({ version: VERSION, theme }, null, 2)}\n`, "utf8");
    renameSync(temp, file);
  } catch {
    // 缓存写失败不该影响使用（下次启动退回系统明暗）
  }
}
