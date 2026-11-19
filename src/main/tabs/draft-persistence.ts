/**
 * 草稿持久化：复用项目已有的「dataDir() 里一份带版本的 JSON + .tmp + renameSync」机制
 * （见 tab-persistence.ts / theme-persistence.ts），不新增数据库、不写进 settings.json。
 *
 * 之所以要持久化：关闭面板 / 切换页签 / 发送失败都不能丢草稿；
 * 应用重启恢复是低成本增强，按「路径 + 会话」匹配回本次启动的页签（见 draft-model.ts）。
 */

import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const FILE = "drafts.json";
const VERSION = 1;
/** 单条草稿最多持久化 20 万字符（内存里不截断，避免用户输入被悄悄改掉） */
export const MAX_PERSIST_CHARS = 200_000;
/** 最多持久化 200 条，防止文件无限增长 */
const MAX_ENTRIES = 200;

export interface PersistedDraft {
  /** 内存草稿 key（tabId::sessionKey），仅用于去重 / 诊断 */
  key: string;
  /** 页签路径，重启后按它匹配 */
  path: string;
  sessionKey: string;
  text: string;
  updatedAt: number;
}

export interface PersistedDrafts {
  version: number;
  entries: PersistedDraft[];
  /** 用户拖出来的面板宽度（可选，旧文件没有就用默认值） */
  panelWidth?: number;
}

function draftsFile(dataDir: string): string {
  return join(dataDir, FILE);
}

/** 读取时全面消毒：文件可能被手工编辑 / 来自旧版本，坏数据一律丢弃而不是让应用崩 */
export function loadDrafts(dataDir: string): PersistedDraft[] {
  const file = draftsFile(dataDir);
  if (!existsSync(file)) return [];
  try {
    const raw = JSON.parse(readFileSync(file, "utf8")) as Partial<PersistedDrafts>;
    return Array.isArray(raw.entries) ? sanitizeEntries(raw.entries) : [];
  } catch {
    return [];
  }
}

function sanitizeEntries(items: Partial<PersistedDraft>[]): PersistedDraft[] {
  const entries: PersistedDraft[] = [];
  for (const item of items) {
    if (!item || typeof item.text !== "string" || typeof item.path !== "string") continue;
    if (typeof item.sessionKey !== "string" || typeof item.key !== "string") continue;
    if (!item.text || item.text.length > MAX_PERSIST_CHARS) continue;
    entries.push({
      key: item.key,
      path: item.path,
      sessionKey: item.sessionKey,
      text: item.text,
      updatedAt: Number.isFinite(item.updatedAt) ? Number(item.updatedAt) : 0,
    });
  }
  return entries.slice(0, MAX_ENTRIES);
}

export function loadPanelWidth(dataDir: string): number | null {
  const file = draftsFile(dataDir);
  if (!existsSync(file)) return null;
  try {
    const raw = JSON.parse(readFileSync(file, "utf8")) as Partial<PersistedDrafts>;
    return Number.isFinite(raw.panelWidth) ? Number(raw.panelWidth) : null;
  } catch {
    return null;
  }
}

/** 写失败只影响「重启后恢复」，绝不影响当前会话，所以吞掉异常 */
export function saveDrafts(dataDir: string, entries: PersistedDraft[], panelWidth?: number): void {
  const file = draftsFile(dataDir);
  const temp = `${file}.tmp`;
  const cleaned = entries
    .filter((entry) => entry.text && entry.text.length <= MAX_PERSIST_CHARS)
    .slice(0, MAX_ENTRIES);
  try {
    writeFileSync(temp, `${JSON.stringify({ version: VERSION, entries: cleaned, panelWidth }, null, 2)}\n`, "utf8");
    renameSync(temp, file);
  } catch {
    // 与 tab-persistence.ts 一致：保存失败不该影响使用
  }
}

export function clearDrafts(dataDir: string): void {
  saveDrafts(dataDir, []);
}
