import { app } from "electron";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export interface RemoteAccessSettings {
  enabled: boolean;
  hostname: string;
  /** 密码不落明文：M2 用系统凭据加密后存 secure.bin，这里只存引用 */
  passwordRef: string | null;
}

export interface AppSettings {
  /** 首选端口 */
  port: number;
  /** 首选端口被占用时的回退区间 [from, to] */
  portFallbackRange: [number, number];
  /** 手工覆盖 pi-web 的 bin/pi-web.js 路径 */
  piWebScriptPath: string | null;
  /** 手工覆盖 node 可执行文件路径 */
  nodePath: string | null;
  /** 已有 pi-web 实例在跑时复用，而不是另起一个 */
  reuseRunningServer: boolean;
  remoteAccess: RemoteAccessSettings;
  /** 关窗口行为：托盘常驻（默认）或退出 */
  closeBehavior: "tray" | "quit";
  launchAtLogin: boolean;
  restoreTabs: boolean;
  alwaysOnTop: boolean;
  exportOpensInTab: boolean;
}

export const DEFAULT_SETTINGS: AppSettings = {
  port: 30141,
  portFallbackRange: [30142, 30150],
  piWebScriptPath: null,
  nodePath: null,
  reuseRunningServer: true,
  remoteAccess: { enabled: false, hostname: "0.0.0.0", passwordRef: null },
  closeBehavior: "tray",
  launchAtLogin: false,
  restoreTabs: true,
  alwaysOnTop: false,
  exportOpensInTab: false,
};

/**
 * 绿色版（portable）把数据放在 exe 同级 ./data，安装版放 %APPDATA%。
 * electron-builder 的 portable target 会设置 PORTABLE_EXECUTABLE_DIR。
 */
export function resolveDataDir(): string {
  const portableDir = process.env.PORTABLE_EXECUTABLE_DIR;
  if (portableDir && portableDir.trim().length > 0) {
    return join(portableDir, "data");
  }
  return app.getPath("userData");
}

let cachedDataDir: string | null = null;

export function dataDir(): string {
  if (!cachedDataDir) {
    cachedDataDir = resolveDataDir();
    mkdirSync(cachedDataDir, { recursive: true });
  }
  return cachedDataDir;
}

export function logFilePath(): string {
  return join(dataDir(), "server.log");
}

function settingsPath(): string {
  return join(dataDir(), "settings.json");
}

let current: AppSettings | null = null;

export function loadSettings(): AppSettings {
  if (current) return current;
  const file = settingsPath();
  let parsed: Partial<AppSettings> = {};
  if (existsSync(file)) {
    try {
      parsed = JSON.parse(readFileSync(file, "utf8")) as Partial<AppSettings>;
    } catch (error) {
      console.warn(`[settings] 读取失败，使用默认值：${(error as Error).message}`);
    }
  }
  current = mergeSettings(DEFAULT_SETTINGS, parsed);
  return current;
}

export function saveSettings(patch: Partial<AppSettings>): AppSettings {
  const next = mergeSettings(loadSettings(), patch);
  current = next;
  try {
    writeFileSync(settingsPath(), `${JSON.stringify(next, null, 2)}\n`, "utf8");
  } catch (error) {
    console.warn(`[settings] 写入失败：${(error as Error).message}`);
  }
  return next;
}

export function getSettings(): AppSettings {
  return loadSettings();
}

function mergeSettings(base: AppSettings, patch: Partial<AppSettings>): AppSettings {
  // patch 里值为 undefined 的字段表示「不改」，不能覆盖掉已有默认值
  const clean: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(patch)) {
    if (value !== undefined) clean[key] = value;
  }
  const merged: AppSettings = { ...base, ...(clean as Partial<AppSettings>) };
  merged.remoteAccess = { ...base.remoteAccess, ...(patch.remoteAccess ?? {}) };
  merged.portFallbackRange = normalizeRange(patch.portFallbackRange ?? base.portFallbackRange);
  merged.port = normalizePort(patch.port ?? base.port, base.port);
  merged.closeBehavior = merged.closeBehavior === "quit" ? "quit" : "tray";
  return merged;
}

function normalizePort(value: unknown, fallback: number): number {
  const port = Number(value);
  return Number.isInteger(port) && port > 0 && port <= 65535 ? port : fallback;
}

function normalizeRange(value: unknown): [number, number] {
  if (!Array.isArray(value) || value.length !== 2) return DEFAULT_SETTINGS.portFallbackRange;
  const from = normalizePort(value[0], DEFAULT_SETTINGS.portFallbackRange[0]);
  const to = normalizePort(value[1], DEFAULT_SETTINGS.portFallbackRange[1]);
  return from <= to ? [from, to] : [to, from];
}
