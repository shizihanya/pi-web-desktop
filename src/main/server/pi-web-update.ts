import { spawn, type ChildProcess } from "node:child_process";
import type { AppSettings } from "../settings";
import { isServing, recordStillAlive } from "./port";
import { npmInvocation, resolveInstall } from "./resolve-pi-web";
import { readRunRecords, type RunRecord } from "./run-records";

const PACKAGE = "@agegr/pi-web";
const CHECK_TIMEOUT_MS = 30_000;
const INSTALL_TIMEOUT_MS = 5 * 60_000;
const MAX_OUTPUT_CHARS = 20_000;

export interface NpmResult {
  code: number | null;
  /** stdout + stderr，用于报错时看尾部 */
  output: string;
  /** 只有 stdout：版本号解析只认它，避免被 npm 的告警行干扰 */
  stdout: string;
  error: string | null;
}

export interface PiWebUpdateCheck {
  /** 磁盘上全局包的版本 */
  current: string;
  /** 当前 npm registry 里的最新稳定版 */
  latest: string;
  hasUpdate: boolean;
  nodePath: string;
  scriptPath: string;
}

/**
 * 异步跑 npm（绝不 spawnSync，避免卡住 Electron 主进程 / 设置窗口）。
 * 检查与安装走同一个 node 自带的 npm-cli.js，所以 registry / .npmrc 配置一致。
 */
export function runNpm(
  nodePath: string,
  args: string[],
  options: { timeoutMs: number; onLine?: (line: string) => void },
): Promise<NpmResult> {
  const invocation = npmInvocation(nodePath, args);
  return new Promise((resolve) => {
    let child: ChildProcess;
    try {
      child = spawn(invocation.command, invocation.args, {
        // 不覆盖 cwd：开发/脚本启动时能沿用项目 .npmrc（registry 与终端里一致）
        env: process.env,
        windowsHide: true,
        shell: invocation.shell,
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (error) {
      resolve({ code: null, output: "", stdout: "", error: `无法启动 npm：${String(error)}` });
      return;
    }

    let output = "";
    let stdout = "";
    let pending = "";
    let settled = false;
    let timer: NodeJS.Timeout | null = null;

    const done = (code: number | null, error: string | null = null): void => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      if (pending.trim()) options.onLine?.(pending.trim());
      resolve({ code, output: output.trim(), stdout: stdout.trim(), error });
    };

    const collect = (chunk: Buffer | string, isStdout: boolean): void => {
      const text = chunk.toString();
      output = (output + text).slice(-MAX_OUTPUT_CHARS);
      if (isStdout) stdout = (stdout + text).slice(-MAX_OUTPUT_CHARS);
      pending += text;
      const lines = pending.split(/\r?\n/);
      pending = lines.pop() ?? "";
      for (const line of lines) {
        const trimmed = line.trim();
        if (trimmed) options.onLine?.(trimmed);
      }
    };

    timer = setTimeout(() => {
      child.kill();
      done(-1, `npm 命令超时（${Math.round(options.timeoutMs / 1000)}s）`);
    }, options.timeoutMs);
    timer.unref?.();

    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: Buffer | string) => collect(chunk, true));
    child.stderr?.on("data", (chunk: Buffer | string) => collect(chunk, false));
    child.once("error", (err) => done(null, err.message));
    child.once("close", (code) => done(code));
  });
}

/** 只认 x.y.z 稳定版，和上游 pi-web update 的口径一致 */
export function parseStableVersion(raw: string): string | null {
  return /^\d+\.\d+\.\d+$/.test(raw.trim()) ? raw.trim() : null;
}

export function isNewerVersion(candidate: string, current: string): boolean {
  const a = candidate.split(".").map(Number);
  const b = current.split(".").map(Number);
  if (a.length !== 3 || b.length !== 3 || a.some((n) => !Number.isFinite(n)) || b.some((n) => !Number.isFinite(n))) {
    return false;
  }
  for (let i = 0; i < 3; i += 1) {
    if (a[i] !== b[i]) return a[i] > b[i];
  }
  return false;
}

function latestFromOutput(output: string): string | null {
  const lines = output.split(/\r?\n/).map((line) => line.trim()).filter(Boolean).reverse();
  for (const line of lines) {
    const version = parseStableVersion(line);
    if (version) return version;
  }
  return null;
}

/** 只读检查：解析全局安装 + 问 npm registry 的最新版本 */
export async function checkPiWebUpdate(settings: AppSettings): Promise<PiWebUpdateCheck> {
  const install = resolveInstall(settings);
  const result = await runNpm(install.nodePath, ["view", PACKAGE, "version"], {
    timeoutMs: CHECK_TIMEOUT_MS,
  });
  const latest = result.error
    ? null
    : (latestFromOutput(result.stdout) ?? latestFromOutput(result.output));
  if (!latest) {
    const detail = result.error ?? (result.output.trim() || "npm view 没有输出");
    throw new Error(`无法读取 ${PACKAGE} 的最新版本：${detail.slice(0, 300)}`);
  }
  return {
    current: install.version,
    latest,
    hasUpdate: isNewerVersion(latest, install.version),
    nodePath: install.nodePath,
    scriptPath: install.scriptPath,
  };
}

/** 钉住版本号安装，避免「检查」和「安装」之间版本漂移 */
export async function installPiWebUpdate(
  nodePath: string,
  version: string,
  onLine?: (line: string) => void,
  /** 失败回滚用较短超时，避免 registry 不可用卡住用户 5 分钟 */
  timeoutMs = INSTALL_TIMEOUT_MS,
): Promise<NpmResult> {
  const safe = parseStableVersion(version);
  if (!safe) return { code: null, output: "", stdout: "", error: `版本号不合法：${version}` };
  return runNpm(nodePath, ["install", "-g", `${PACKAGE}@${safe}`], {
    timeoutMs,
    onLine,
  });
}

/**
 * 更新前确认没有别的 pi-web 还在跑：全局包的 .next/ 会被占用，
 * Windows 上覆盖安装可能失败或留下半更新的目录（上游 pi-web update 也会拒绝这种情况）。
 * 这里只读运行记录 + 探端口，不会杀任何外部进程。
 */
export async function runningPiWebInstances(): Promise<RunRecord[]> {
  const candidates = readRunRecords().filter((record) => recordStillAlive(record));
  // Next.js 冷响应偶尔要 2s+，超时给足，宁可误报「仍有实例」也不要漏报导致半更新
  const checks = await Promise.all(
    candidates.map(async (record) => ((await isServing(record.url, 3_000)) ? record : null)),
  );
  return checks.filter((record): record is RunRecord => record !== null);
}
