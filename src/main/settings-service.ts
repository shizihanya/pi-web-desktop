import { app, BrowserWindow, clipboard, ipcMain } from "electron";
import { randomInt } from "node:crypto";
import {
  SETTINGS_IPC,
  type LanAddress,
  type PiWebUpdateProgress,
  type PiWebUpdateResult,
  type SaveResult,
  type ServerState,
  type SettingsPatch,
  type SettingsView,
} from "../shared/types";
import { dataDir, loadSettings, saveSettings, type AppSettings } from "./settings";
import {
  REMOTE_ACCESS_KEY,
  deleteSecret,
  hasSecret,
  saveSecret,
  secureAvailable,
} from "./secret-store";
import { listLanAddresses } from "./server/network";
import {
  checkPiWebUpdate,
  installPiWebUpdate,
  runningPiWebInstances,
} from "./server/pi-web-update";
import { resolveInstall } from "./server/resolve-pi-web";
import type { ServerManager } from "./server/server-manager";

const MIN_PASSWORD_LENGTH = 8;
const IDLE_STATE: ServerState = {
  phase: "idle",
  url: null,
  port: null,
  hostname: null,
  managed: false,
  version: null,
  message: null,
  detail: null,
};

export interface SettingsServiceDeps {
  getServer: () => ServerManager | null;
  /** 重启服务 + 重建窗口（端口/绑定/安装路径变化时） */
  restartAll: () => Promise<void>;
  /** 立即生效的设置（托盘行为、窗口置顶等） */
  onChange: (settings: AppSettings) => void;
}

export class SettingsService {
  /** 升级会停服务 + 改全局包，必须串行，禁止重复点击 */
  private updateRunning = false;

  constructor(private readonly deps: SettingsServiceDeps) {}

  lan(): LanAddress[] {
    const settings = loadSettings();
    if (!settings.remoteAccess.enabled) return [];
    const state = this.deps.getServer()?.getState() ?? IDLE_STATE;
    return listLanAddresses(state.port ?? settings.port);
  }

  view(): SettingsView {
    const settings = loadSettings();
    const server = this.deps.getServer();
    const state = server?.getState() ?? IDLE_STATE;

    let resolved = null;
    try {
      resolved = resolveInstall(settings);
    } catch {
      resolved = server?.getInstall() ?? null;
    }

    return {
      port: settings.port,
      portFallbackRange: settings.portFallbackRange,
      closeBehavior: settings.closeBehavior,
      launchAtLogin: settings.launchAtLogin,
      restoreTabs: settings.restoreTabs,
      alwaysOnTop: settings.alwaysOnTop,
      remoteAccessEnabled: settings.remoteAccess.enabled,
      hasPassword: hasSecret(REMOTE_ACCESS_KEY),
      piWebScriptPath: settings.piWebScriptPath,
      nodePath: settings.nodePath,
      resolved,
      server: state,
      lanAddresses: this.lan(),
      portable: Boolean(process.env.PORTABLE_EXECUTABLE_DIR),
      dataDir: dataDir(),
    };
  }

  generatePassword(): string {
    const alphabet = "abcdefghijkmnopqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789";
    let result = "";
    for (let index = 0; index < 20; index += 1) result += alphabet[randomInt(0, alphabet.length)];
    return result;
  }

  /**
   * 设置页「检查 pi-web 更新」的完整流程：
   *   检查 registry → 停本应用托管的服务 → 确认没有外部实例占着文件
   *   → npm install -g 钉版本 → 重解析版本 → 重启服务（且这一次不复用旧实例）。
   * 任何一步失败都会把服务恢复到旧版本，不会让用户停在「没有服务」的状态。
   */
  async runPiWebUpdate(emit: (progress: PiWebUpdateProgress) => void): Promise<PiWebUpdateResult> {
    if (this.updateRunning) {
      return {
        ok: false,
        status: "failed",
        message: "已有更新任务在进行中。",
        current: null,
        latest: null,
        installed: null,
        view: this.view(),
      };
    }
    this.updateRunning = true;

    const send = (
      phase: PiWebUpdateProgress["phase"],
      message: string,
      extra: Partial<PiWebUpdateProgress> = {},
    ): void => emit({ phase, message, ...extra });

    let stopped = false;
    let current: string | null = null;
    let latest: string | null = null;
    let installed: string | null = null;

    try {
      send("checking", "正在检查 pi-web 新版本…");
      const check = await checkPiWebUpdate(loadSettings());
      current = check.current;
      latest = check.latest;
      if (!check.hasUpdate) {
        const message = `当前 v${current} 已是最新版本。`;
        send("up-to-date", message, { current, latest, installed: current });
        return {
          ok: true,
          status: "up-to-date",
          message,
          current,
          latest,
          installed: current,
          view: this.view(),
        };
      }

      const target = check.latest;
      send("stopping", `发现新版本 v${target}（当前 v${current}），正在停止服务…`, {
        current,
        latest,
      });
      const manager = this.deps.getServer();
      await manager?.stop();
      stopped = true;

      const running = await runningPiWebInstances();
      if (running.length > 0) {
        const ports = [...new Set(running.map((record) => record.port))];
        const portArg = ports.length === 1 ? ` --port ${ports[0]}` : "";
        throw new Error(
          `还有 pi-web 实例在运行（${running.map((record) => record.url).join("、")}），` +
            `全局包文件被占用，无法安全更新。请先在对应终端执行 pi-web stop${portArg}，然后重试。`,
        );
      }

      send("installing", `正在更新全局包到 @agegr/pi-web@${target}…`, { current, latest });
      const npm = await installPiWebUpdate(check.nodePath, target, (line) => {
        send("installing", `正在更新全局包到 v${target}…`, { current, latest, log: line });
      });
      if (npm.error || npm.code !== 0) {
        const tail = npm.output.split(/\r?\n/).slice(-8).join(" ").trim();
        throw new Error(
          `npm install 失败${npm.error ? `：${npm.error}` : `（退出码 ${npm.code}）`}${tail ? `：${tail}` : ""}`,
        );
      }
      this.deps.getServer()?.log(`[update] npm install -g @agegr/pi-web@${target} 完成`);

      const after = resolveInstall(loadSettings());
      installed = after.version;
      if (after.version !== target) {
        throw new Error(
          `安装后解析到 v${after.version}（预期 v${target}），可能装到了另一份全局目录。` +
            `请检查 npm root -g 与设置页里的实际脚本路径。`,
        );
      }

      send("restarting", `已安装 v${installed}，正在重启服务…`, { current, latest, installed });
      manager?.clearInstall();
      manager?.disableReuseOnce();
      await this.deps.restartAll();

      const state = this.deps.getServer()?.getState();
      if (!state || state.phase !== "ready") {
        const detail = state?.message ?? "服务未能就绪，请看启动页或 server.log";
        const message = `已安装 v${installed}，但服务重启失败：${detail}`;
        send("failed", message, { current, latest, installed });
        return {
          ok: false,
          status: "failed",
          message,
          current,
          latest,
          installed,
          view: this.view(),
        };
      }

      const message = `已更新到 v${installed} 并重启服务（${state.url}）。`;
      send("done", message, { current, latest, installed });
      return {
        ok: true,
        status: "updated",
        message,
        current,
        latest,
        installed,
        view: this.view(),
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      send("failed", `更新失败：${message}`, { current, latest, installed });
      if (stopped) {
        // 无论失败在哪一步，都把服务拉回旧版本（全局包可能还没动，也可能已装好）
        try {
          await this.deps.restartAll();
        } catch (restoreError) {
          this.deps.getServer()?.log(`[update] 恢复服务失败：${String(restoreError)}`);
        }
      }
      return {
        ok: false,
        status: "failed",
        message,
        current,
        latest,
        installed,
        view: this.view(),
      };
    } finally {
      this.updateRunning = false;
    }
  }

  async save(patch: SettingsPatch, restart: boolean): Promise<SaveResult> {
    const before = loadSettings();
    const wantsRemote = patch.remoteAccess?.enabled ?? before.remoteAccess.enabled;
    const passwordInput = patch.remoteAccess?.password;

    if (wantsRemote) {
      const willHavePassword =
        (typeof passwordInput === "string" && passwordInput.trim().length > 0) ||
        hasSecret(REMOTE_ACCESS_KEY);
      if (!willHavePassword) {
        return this.failure("开启局域网访问前，请先设置一个访问密码。");
      }
      if (typeof passwordInput === "string" && passwordInput.trim().length > 0) {
        if (passwordInput.trim().length < MIN_PASSWORD_LENGTH) {
          return this.failure(`密码至少 ${MIN_PASSWORD_LENGTH} 位。`);
        }
        if (!secureAvailable()) {
          return this.failure("当前系统不支持安全存储（DPAPI 不可用），暂时无法保存密码。");
        }
        saveSecret(REMOTE_ACCESS_KEY, passwordInput.trim());
      }
    } else if (passwordInput === null) {
      deleteSecret(REMOTE_ACCESS_KEY);
    }

    const next = saveSettings({
      port: patch.port,
      closeBehavior: patch.closeBehavior,
      launchAtLogin: patch.launchAtLogin,
      restoreTabs: patch.restoreTabs,
      alwaysOnTop: patch.alwaysOnTop,
      piWebScriptPath: patch.piWebScriptPath,
      nodePath: patch.nodePath,
      remoteAccess: {
        enabled: wantsRemote,
        hostname: "0.0.0.0",
        passwordRef: wantsRemote ? REMOTE_ACCESS_KEY : null,
      },
    });

    this.applyLoginItem(next);

    const needsRestart =
      next.port !== before.port ||
      next.remoteAccess.enabled !== before.remoteAccess.enabled ||
      next.piWebScriptPath !== before.piWebScriptPath ||
      next.nodePath !== before.nodePath;

    this.deps.onChange(next);

    if (needsRestart && restart) {
      await this.deps.restartAll();
    }

    return { ok: true, needsRestart, view: this.view() };
  }

  applyLoginItem(settings: AppSettings): void {
    if (process.env.PORTABLE_EXECUTABLE_DIR) return; // 绿色版路径会变，不注册开机自启
    try {
      app.setLoginItemSettings({
        openAtLogin: settings.launchAtLogin,
        args: ["--hidden"],
      });
    } catch {
      // 某些环境不允许写注册表，忽略
    }
  }

  registerIpc(): void {
    ipcMain.handle(SETTINGS_IPC.load, () => this.view());
    ipcMain.handle(SETTINGS_IPC.save, (_event, patch: SettingsPatch) => this.save(patch, false));
    ipcMain.handle(SETTINGS_IPC.saveAndRestart, (_event, patch: SettingsPatch) =>
      this.save(patch, true),
    );
    ipcMain.handle(SETTINGS_IPC.generatePassword, () => this.generatePassword());
    ipcMain.handle(SETTINGS_IPC.refreshLan, () => this.lan());
    ipcMain.handle(SETTINGS_IPC.copy, (_event, text: string) => {
      clipboard.writeText(String(text ?? ""));
    });
    ipcMain.handle(SETTINGS_IPC.close, (event) => {
      BrowserWindow.fromWebContents(event.sender)?.close();
    });
    ipcMain.handle(SETTINGS_IPC.updatePiWeb, (event) =>
      this.runPiWebUpdate((progress) => {
        // 阶段消息进 server.log；npm 的逐行输出只发设置页，避免刷屏
        if (!progress.log) this.deps.getServer()?.log(`[update] ${progress.message}`);
        if (!event.sender.isDestroyed()) {
          event.sender.send(SETTINGS_IPC.piWebUpdateEvent, progress);
        }
      }),
    );
  }

  private failure(message: string): SaveResult {
    return { ok: false, message, needsRestart: false, view: this.view() };
  }
}
