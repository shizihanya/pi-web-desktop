import { findRecordByPort, isProcessAlive, type RunRecord } from "./run-records";
import type { AppSettings } from "../settings";

const PROBE_TIMEOUT_MS = 1_500;

/**
 * 端口上是否有服务在应答。
 * 注意：任何 HTTP 状态码都算「活着」——开启 PI_WEB_PASSWORD 后 / 会 302 到 /login，
 * 接口返回 401，只认 200 会误判成「没人监听」。
 */
export async function isServing(url: string, timeoutMs = PROBE_TIMEOUT_MS): Promise<boolean> {
  try {
    const response = await fetch(url, {
      redirect: "manual",
      signal: AbortSignal.timeout(timeoutMs),
    });
    await response.body?.cancel().catch(() => {});
    return true;
  } catch {
    return false;
  }
}

const LOOPBACK = new Set(["127.0.0.1", "localhost", "::1", "[::1]"]);

export function isLoopbackHost(hostname: string): boolean {
  return LOOPBACK.has(hostname);
}

export interface PortChoice {
  port: number;
  /** 该端口上已有一个可以复用的 pi-web */
  existing: RunRecord | null;
  /** 端口被占但不可复用的原因（给日志用） */
  skipped?: string;
}

function candidatePorts(settings: AppSettings): number[] {
  const [from, to] = settings.portFallbackRange;
  const ports = [settings.port];
  for (let port = from; port <= to; port += 1) ports.push(port);
  return [...new Set(ports)];
}

/**
 * 选一个可用端口。
 *
 * 复用规则很保守，避免把「本该有密码的局域网服务」接到一个没有密码的旧实例上：
 * - 只复用绑在回环地址上的实例
 * - 本次要求开启局域网访问（需要自己控制密码）时，**绝不复用**
 * - 端口被占但不可复用 → 换下一个端口，而不是硬上
 */
export async function pickPort(
  settings: AppSettings,
  options: { allowReuse: boolean },
): Promise<PortChoice> {
  const ports = candidatePorts(settings);
  const wantsRemote = settings.remoteAccess.enabled;
  let skipped: string | undefined;

  for (const port of ports) {
    const url = `http://127.0.0.1:${port}`;
    if (!(await isServing(url))) {
      return { port, existing: null, skipped };
    }

    if (!options.allowReuse || wantsRemote) {
      skipped = `${port} 被占用（${wantsRemote ? "本次要求局域网+密码，不能复用外部实例" : "已禁用复用"}），改用下一个端口`;
      continue;
    }

    const record = findRecordByPort(port);
    if (!record) {
      skipped = `${port} 被占用，但运行记录里找不到对应的 pi-web，改用下一个端口`;
      continue;
    }
    if (!isLoopbackHost(record.hostname)) {
      skipped = `${port} 上的 pi-web 绑定在 ${record.hostname}（非回环），为避免安全风险不复用`;
      continue;
    }
    if (await isServing(record.url)) {
      return { port, existing: record, skipped };
    }
    skipped = `${port} 的记录已失效，改用下一个端口`;
  }

  // 全都不可用：仍然用首选端口，让 pi-web 自己报错（错误信息会带 EADDRINUSE）
  return { port: settings.port, existing: null, skipped };
}

/** 端口上的进程是否还是我们记录的那个（防止 PID 复用误杀） */
export function recordStillAlive(record: RunRecord): boolean {
  return isProcessAlive(record.pid) || (record.nextPid ? isProcessAlive(record.nextPid) : false);
}
