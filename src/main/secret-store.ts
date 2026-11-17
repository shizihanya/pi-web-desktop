import { safeStorage } from "electron";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { dataDir } from "./settings";

/**
 * 远程访问密码：用 Electron 的系统凭据加密（Windows 上是 DPAPI）后存 secure.bin。
 * 明文既不进 settings.json，也不进日志。
 */
const FILE = "secure.bin";

export function secureAvailable(): boolean {
  try {
    return safeStorage.isEncryptionAvailable();
  } catch {
    return false;
  }
}

function readAll(): Record<string, string> {
  const file = join(dataDir(), FILE);
  if (!existsSync(file)) return {};
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8")) as Record<string, string>;
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

function writeAll(payload: Record<string, string>): void {
  writeFileSync(join(dataDir(), FILE), JSON.stringify(payload), { encoding: "utf8", mode: 0o600 });
}

export function saveSecret(key: string, value: string): boolean {
  if (!secureAvailable()) return false;
  const payload = readAll();
  payload[key] = safeStorage.encryptString(value).toString("base64");
  writeAll(payload);
  return true;
}

export function readSecret(key: string): string | null {
  const token = readAll()[key];
  if (!token) return null;
  try {
    return safeStorage.decryptString(Buffer.from(token, "base64"));
  } catch {
    return null;
  }
}

export function deleteSecret(key: string): void {
  const payload = readAll();
  if (!(key in payload)) return;
  delete payload[key];
  writeAll(payload);
}

export function hasSecret(key: string): boolean {
  return Boolean(readAll()[key]);
}

export const REMOTE_ACCESS_KEY = "remote-access";
