import { spawn, type ChildProcess } from "node:child_process";

const CHECK_TIMEOUT_MS = 30_000;
const UPDATE_TIMEOUT_MS = 5 * 60_000;
const MAX_OUTPUT_CHARS = 20_000;

export interface PiCommandResult {
  code: number | null;
  /** stdout + stderr，用于报错时看尾部 */
  output: string;
  /** 只有 stdout：版本号解析只认它，避免被进度/告警行干扰 */
  stdout: string;
  error: string | null;
}

export type PiUpdateOutcome = "updated" | "up-to-date" | "failed";

/** 异步跑 pi CLI；Windows 上 pi 是 cmd / ps1 shim，必须经 shell 才能执行。 */
export function runPi(
  args: string[],
  options: { timeoutMs?: number; onLine?: (line: string) => void } = {},
): Promise<PiCommandResult> {
  const timeoutMs = options.timeoutMs ?? UPDATE_TIMEOUT_MS;
  return new Promise((resolve) => {
    let child: ChildProcess;
    try {
      child = spawn("pi", args, {
        env: process.env,
        windowsHide: true,
        shell: process.platform === "win32",
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (error) {
      resolve({ code: null, output: "", stdout: "", error: `无法启动 pi：${String(error)}` });
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
      done(-1, `pi 命令超时（${Math.round(timeoutMs / 1000)}s）`);
    }, timeoutMs);
    timer.unref?.();

    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: Buffer | string) => collect(chunk, true));
    child.stderr?.on("data", (chunk: Buffer | string) => collect(chunk, false));
    child.once("error", (error) => done(null, error.message));
    child.once("close", (code) => done(code));
  });
}

/** `pi --version` 的当前版本；失败返回 null，不把版本解析错误当成更新失败。 */
export async function readPiVersion(): Promise<string | null> {
  const result = await runPi(["--version"], { timeoutMs: CHECK_TIMEOUT_MS });
  if (result.error || result.code !== 0) return null;
  return /\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?/.exec(result.stdout || result.output)?.[0] ?? null;
}

/**
 * pi update 自己完成「检查 + 按需更新」，没有单独的 --check。
 * 因此按它的稳定输出判定结果：updated / already up to date / failed。
 */
export function classifyPiUpdate(result: PiCommandResult): PiUpdateOutcome {
  if (result.error || result.code !== 0) return "failed";
  if (/\b(?:Error:|was not updated|Skipped package updates \(offline mode\))/i.test(result.output)) {
    return "failed";
  }
  if (/\bUpdated\s+\d+\s+packages?\s*:/i.test(result.output)) return "updated";
  if (/\bUpdated\s+pi\s+from\b/i.test(result.output)) return "updated";
  if (/\balready up to date\b/i.test(result.output)) return "up-to-date";
  return "failed";
}

/** 失败信息只取输出尾部，避免把整段 npm 日志塞进状态栏。 */
export function piOutputTail(output: string, lines = 8): string {
  return output.split(/\r?\n/).map((line) => line.trim()).filter(Boolean).slice(-lines).join(" ");
}
