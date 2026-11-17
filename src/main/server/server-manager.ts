import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { resolveInstall, ResolveError, type PiWebInstall } from "./resolve-pi-web";
import { isServing, pickPort, recordStillAlive } from "./port";
import { ServerLogger } from "../logger";
import type { AppSettings } from "../settings";
import type { ServerState } from "../../shared/types";

const READY_TIMEOUT_MS = 90_000;
const POLL_INTERVAL_MS = 350;
const STOP_TIMEOUT_MS = 8_000;
const HEALTH_INTERVAL_MS = 5_000;
const HEALTH_FAILURES_BEFORE_RECOVERY = 2;
const MAX_AUTO_RESTARTS = 3;
const AUTO_RESTART_WINDOW_MS = 120_000;

function emptyState(phase: ServerState["phase"]): ServerState {
  return {
    phase,
    url: null,
    port: null,
    hostname: null,
    managed: false,
    version: null,
    message: null,
    detail: null,
  };
}

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * pi-web 服务的生命周期：
 *   解析安装位置 → 选端口（可复用已有实例）→ spawn → 等就绪 → 退出时杀掉整棵进程树。
 * 完全不修改 pi-web 自身，只用它的 CLI 参数与运行记录。
 */
export class ServerManager {
  private state: ServerState = emptyState("idle");
  private child: ChildProcess | null = null;
  private install: PiWebInstall | null = null;
  private pending: Promise<ServerState> | null = null;
  private stopRequested = false;
  private watchTimer: NodeJS.Timeout | null = null;
  private healthFailures = 0;
  private autoRestarts = 0;
  private autoRestartWindowStart = 0;
  private recovering = false;
  /** 更新 pi-web 后的下一次启动禁止复用旧实例（一次性） */
  private skipReuseOnce = false;
  private readonly logger: ServerLogger;
  private readonly stateListeners = new Set<(state: ServerState) => void>();

  constructor(
    private settings: AppSettings,
    logFile: string,
    private readonly options: { getPassword?: () => string | null } = {},
  ) {
    this.logger = new ServerLogger(logFile);
  }

  setSettings(settings: AppSettings): void {
    this.settings = settings;
  }

  getState(): ServerState {
    return this.state;
  }

  getInstall(): PiWebInstall | null {
    return this.install;
  }

  getSettings(): AppSettings {
    return this.settings;
  }

  onState(listener: (state: ServerState) => void): () => void {
    this.stateListeners.add(listener);
    return () => this.stateListeners.delete(listener);
  }

  onLog(listener: (line: string) => void): () => void {
    return this.logger.onLine(listener);
  }

  logs(): string[] {
    return this.logger.lines();
  }

  log(line: string): void {
    this.logger.write(line);
  }

  async start(): Promise<ServerState> {
    if (this.state.phase === "ready") return this.state;
    if (!this.pending) {
      this.pending = this.doStart().finally(() => {
        this.pending = null;
      });
    }
    return this.pending;
  }

  async restart(): Promise<ServerState> {
    await this.stop();
    return this.start();
  }

  /** 让下次启动重新读一次安装路径（比如用户在设置里改了指路径） */
  clearInstall(): void {
    this.install = null;
  }

  /** 下一次启动不要复用端口上的旧实例：用于 pi-web 升级后强制拉起新版本 */
  disableReuseOnce(): void {
    this.skipReuseOnce = true;
  }

  async stop(): Promise<void> {
    this.stopRequested = true;
    this.stopWatch();
    this.setState(emptyState("idle"));
    const child = this.child;
    this.child = null;
    if (!child || child.pid === undefined) return;

    this.logger.write(`[stop] 结束 pi-web 进程树 (pid ${child.pid})`);
    killTree(child.pid);
    const deadline = Date.now() + STOP_TIMEOUT_MS;
    while (Date.now() < deadline) {
      if (child.exitCode !== null || child.signalCode !== null) return;
      await delay(150);
    }
    this.logger.write(`[stop] 警告：pid ${child.pid} 在 ${STOP_TIMEOUT_MS / 1000}s 内未退出`);
  }

  private async doStart(): Promise<ServerState> {
    this.stopRequested = false;
    this.setState(emptyState("resolving"));

    let install: PiWebInstall;
    try {
      install = resolveInstall(this.settings);
    } catch (error) {
      const message =
        error instanceof ResolveError ? error.message : `无法定位 pi-web：${String(error)}`;
      const detail = error instanceof ResolveError ? error.detail : String(error);
      this.logger.write(`[resolve] ${message}`);
      return this.fail(message, detail);
    }

    this.install = install;
    this.logger.write(`[resolve] node ${install.nodeVersion} → ${install.nodePath}`);
    this.logger.write(`[resolve] pi-web v${install.version} → ${install.scriptPath}`);

    const hostname = this.settings.remoteAccess.enabled
      ? this.settings.remoteAccess.hostname
      : "127.0.0.1";

    // 局域网访问沿用上游 PI_WEB_PASSWORD 机制：开即必须有密码
    let password: string | null = null;
    if (this.settings.remoteAccess.enabled) {
      password = this.options.getPassword?.() ?? null;
      if (!password) {
        const message = "已开启局域网访问，但还没有设置访问密码。";
        this.logger.write(`[remote] ${message}`);
        return this.fail(message, "请在「设置 → 局域网访问」里生成或填写一个密码，然后重试。");
      }
    }

    // 要求局域网+密码时自己拉一个实例；升级 pi-web 后也不复用旧实例，
    // 哪怕端口上还残留旧版本进程，保证跑起来的一定是刚安装的新版本。
    const allowReuse =
      this.settings.reuseRunningServer &&
      !this.settings.remoteAccess.enabled &&
      !this.skipReuseOnce;
    this.skipReuseOnce = false;
    const choice = await pickPort(this.settings, { allowReuse });
    if (choice.skipped) this.logger.write(`[port] ${choice.skipped}`);
    const port = choice.port;
    const url = `http://127.0.0.1:${port}`;

    if (choice.existing && recordStillAlive(choice.existing)) {
      this.logger.write(
        `[reuse] 复用已在运行的 pi-web v${choice.existing.version} (${choice.existing.url})`,
      );
      this.setState({
        phase: "ready",
        url: choice.existing.url,
        port,
        hostname: choice.existing.hostname,
        managed: false,
        version: choice.existing.version,
        message: null,
        detail: null,
      });
      this.startWatch();
      return this.state;
    }

    if (password) {
      this.logger.write(`[remote] 绑定 ${hostname}，已启用密码访问（密码不写入日志）`);
    }

    this.setState({
      phase: "starting",
      url,
      port,
      hostname,
      managed: true,
      version: install.version,
      message: null,
      detail: null,
    });

    const args = ["--no-open", "-p", String(port), "-H", hostname];
    this.logger.write(`[spawn] ${install.nodePath} ${install.scriptPath} ${args.join(" ")}`);

    const child = spawn(install.nodePath, [install.scriptPath, ...args], {
      cwd: process.env.USERPROFILE ?? process.cwd(),
      env: {
        ...process.env,
        PI_WEB_NO_OPEN: "1",
        // 密码只通过环境变量传，不进命令行（不会出现在进程列表里）
        ...(password ? { PI_WEB_PASSWORD: password } : {}),
      },
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    this.child = child;

    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => this.logger.writeChunk(chunk));
    child.stderr?.on("data", (chunk: string) => this.logger.writeChunk(chunk));

    const exited = new Promise<number>((resolve) => {
      child.once("exit", (code, signal) => {
        this.logger.write(`[exit] pi-web 退出 code=${code ?? "null"} signal=${signal ?? "null"}`);
        resolve(code ?? -1);
      });
      child.once("error", (error) => {
        this.logger.write(`[exit] 无法启动进程：${error.message}`);
        resolve(-1);
      });
    });

    const ready = await Promise.race([
      this.waitUntilServing(url).then(() => true),
      exited.then(() => false),
    ]).catch(() => false);

    if (!ready || this.stopRequested) {
      const tail = this.logger.tail(20);
      if (!this.stopRequested) {
        this.logger.write("[ready] 服务未能在限定时间内就绪");
      }
      await this.stop();
      return this.fail(
        "pi-web 服务没能启动起来。",
        tail || "没有更多日志，试试手动在终端运行 pi-web 看看报错。",
      );
    }

    child.once("exit", (code) => {
      if (this.stopRequested || this.recovering) return;
      if (this.state.phase !== "ready") return;
      this.logger.write(`[exit] 服务在运行中意外退出（code=${code ?? "unknown"}），尝试自动恢复`);
      void this.recover("进程意外退出");
    });

    this.logger.write(`[ready] ${url} (pi-web v${install.version})`);
    this.setState({
      phase: "ready",
      url,
      port,
      hostname,
      managed: true,
      version: install.version,
      message: null,
      detail: null,
    });
    this.startWatch();
    return this.state;
  }

  private async waitUntilServing(url: string): Promise<void> {
    const deadline = Date.now() + READY_TIMEOUT_MS;
    while (Date.now() < deadline) {
      if (this.stopRequested) return;
      if (await isServing(url, 1_200)) return;
      await delay(POLL_INTERVAL_MS);
    }
    throw new Error(`等待 ${url} 就绪超时`);
  }

  /* ------------------------- 服务健康监护 ------------------------- */

  /**
   * 服务就绪后定期探一下：
   * - 自己拉起的进程死了 → 杀掉残留后重拉
   * - 复用的外部实例被人关了 → 接管，自己拉一个
   * 这就是「不开终端也能用」的兜底。
   */
  private startWatch(): void {
    this.stopWatch();
    this.healthFailures = 0;
    this.watchTimer = setInterval(() => void this.checkHealth(), HEALTH_INTERVAL_MS);
    this.watchTimer.unref?.();
  }

  private stopWatch(): void {
    if (this.watchTimer) clearInterval(this.watchTimer);
    this.watchTimer = null;
    this.healthFailures = 0;
  }

  private async checkHealth(): Promise<void> {
    if (this.recovering || this.stopRequested) return;
    const state = this.state;
    if (state.phase !== "ready" || !state.url) return;

    const alive = await isServing(state.url, 2_000);
    if (alive) {
      this.healthFailures = 0;
      return;
    }

    this.healthFailures += 1;
    if (this.healthFailures < HEALTH_FAILURES_BEFORE_RECOVERY) return;

    this.logger.write(
      `[health] ${state.url} 不再应答（${state.managed ? "本应用拉起的进程" : "复用的外部实例"}）`,
    );
    await this.recover("健康检查失败");
  }

  /** 自动恢复：杀掉残留 → 重新拉起（带次数限制，避免死循环） */
  private async recover(reason: string): Promise<void> {
    if (this.recovering || this.stopRequested) return;

    const now = Date.now();
    if (now - this.autoRestartWindowStart > AUTO_RESTART_WINDOW_MS) {
      this.autoRestartWindowStart = now;
      this.autoRestarts = 0;
    }
    if (this.autoRestarts >= MAX_AUTO_RESTARTS) {
      this.stopWatch();
      this.fail(
        "pi-web 服务反复退出，已停止自动重启。",
        `最近 ${AUTO_RESTART_WINDOW_MS / 60_000} 分钟内自动重启了 ${this.autoRestarts} 次。\n` +
          `可以在菜单「服务 → 重启服务」手动重试，或看日志排查。\n\n${this.logger.tail(20)}`,
      );
      return;
    }
    this.autoRestarts += 1;

    this.recovering = true;
    try {
      // 自己的进程可能卡死：先杀干净，避免端口仍被占
      const pid = this.child?.pid;
      this.child = null;
      if (pid !== undefined) killTree(pid);
      this.stopWatch();
      this.setState(emptyState("idle"));
      const state = await this.start();
      if (state.phase === "ready") {
        this.logger.write(`[health] 已自动恢复（第 ${this.autoRestarts} 次，原因：${reason}）`);
      }
    } finally {
      this.recovering = false;
    }
  }

  private fail(message: string, detail: string): ServerState {
    this.setState({
      ...emptyState("failed"),
      version: this.install?.version ?? null,
      message,
      detail,
    });
    return this.state;
  }

  private setState(next: ServerState): void {
    this.state = next;
    for (const listener of this.stateListeners) {
      try {
        listener(next);
      } catch {
        // 忽略渲染进程侧的异常
      }
    }
  }
}

/** Windows 上必须杀整棵进程树：pi-web CLI + next-server 两跳 */
export function killTree(pid: number): void {
  if (process.platform === "win32") {
    spawnSync("taskkill", ["/PID", String(pid), "/T", "/F"], {
      windowsHide: true,
      timeout: 15_000,
    });
    return;
  }
  try {
    process.kill(pid, "SIGTERM");
  } catch {
    // 已经没了
  }
  setTimeout(() => {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      // 已经没了
    }
  }, 3_000).unref();
}
