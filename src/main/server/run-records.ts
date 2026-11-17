import { existsSync, readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/**
 * pi-web 自己维护的运行记录：<agentDir>/pi-web-run/<launcher pid>.json
 * 只读，用来判断「某个端口上跑的到底是不是 pi-web」。
 */
export interface RunRecord {
  pid: number;
  nextPid?: number;
  port: number;
  hostname: string;
  url: string;
  version: string;
  startedAt: string;
}

export function agentDir(): string {
  const configured = process.env.PI_CODING_AGENT_DIR;
  const home = homedir();
  if (!configured) return join(home, ".pi", "agent");
  if (configured === "~") return home;
  if (configured.startsWith("~/") || configured.startsWith("~\\")) {
    return join(home, configured.slice(2));
  }
  return configured;
}

export function runRecordsDir(): string {
  return join(agentDir(), "pi-web-run");
}

export function readRunRecords(): RunRecord[] {
  const dir = runRecordsDir();
  if (!existsSync(dir)) return [];
  const records: RunRecord[] = [];
  for (const name of readdirSync(dir)) {
    if (!name.endsWith(".json")) continue;
    try {
      const raw = JSON.parse(readFileSync(join(dir, name), "utf8")) as Partial<RunRecord>;
      if (typeof raw.port !== "number" || typeof raw.url !== "string") continue;
      records.push({
        pid: Number(raw.pid ?? 0),
        nextPid: raw.nextPid === undefined ? undefined : Number(raw.nextPid),
        port: raw.port,
        hostname: String(raw.hostname ?? "127.0.0.1"),
        url: raw.url,
        version: String(raw.version ?? "unknown"),
        startedAt: String(raw.startedAt ?? ""),
      });
    } catch {
      // 损坏的记录忽略即可：pi-web 自己也会清理
    }
  }
  return records;
}

export function findRecordByPort(port: number): RunRecord | null {
  return readRunRecords().find((record) => record.port === port) ?? null;
}

export function isProcessAlive(pid: number): boolean {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}
