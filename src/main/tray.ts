import { Menu, Tray, clipboard, nativeImage } from "electron";
import type { LanAddress, ServerState, TabsSnapshot } from "../shared/types";
import { trayIconPath } from "./assets";

export interface TrayContext {
  getState: () => ServerState;
  getTabs: () => TabsSnapshot | null;
  getLan: () => LanAddress[];
  isRemoteEnabled: () => boolean;
  showWindow: () => void;
  activateTab: (id: string) => void;
  restartServer: () => void;
  openLog: () => void;
  openSettings: () => void;
  quit: () => void;
}

const PHASE_LABEL: Record<ServerState["phase"], string> = {
  idle: "未启动",
  resolving: "定位安装",
  starting: "启动中",
  ready: "运行中",
  failed: "启动失败",
};

/** 托盘常驻：关窗口 ≠ 退出，服务继续跑（局域网也能继续用） */
export class AppTray {
  private tray: Tray | null = null;
  private balloonShown = false;

  constructor(private readonly context: TrayContext) {}

  get exists(): boolean {
    return this.tray !== null && !this.tray.isDestroyed();
  }

  create(): void {
    if (this.exists) return;
    const file = trayIconPath();
    const source = file ? nativeImage.createFromPath(file) : nativeImage.createEmpty();
    const image = source.isEmpty() ? source : source.resize({ width: 16, height: 16 });
    this.tray = new Tray(image);
    this.tray.setToolTip("Pi Web Desktop");
    this.tray.on("click", () => this.context.showWindow());
    this.tray.on("double-click", () => this.context.showWindow());
    this.refresh();
  }

  destroy(): void {
    this.tray?.destroy();
    this.tray = null;
  }

  /** 服务状态 / 页签 / 局域网地址变化后刷新 */
  refresh(): void {
    if (!this.exists || !this.tray) return;
    const state = this.context.getState();
    const port = state.port ?? "-";
    this.tray.setToolTip(`Pi Web Desktop · ${PHASE_LABEL[state.phase]} · ${port}`);

    const lan = this.context.getLan();
    const tabs = this.context.getTabs();

    const menu = Menu.buildFromTemplate([
      { label: `Pi Web Desktop — ${PHASE_LABEL[state.phase]}（${port}）`, enabled: false },
      { type: "separator" },
      { label: "显示主窗口", click: () => this.context.showWindow() },
      {
        label: "页签",
        submenu: tabs
          ? tabs.tabs.length === 0
            ? [{ label: "（没有页签）", enabled: false }]
            : tabs.tabs.map((tab) => {
                // 分屏时给正在显示的页签标上窗格号（单栏时不加任何前缀，保持原样）
                const group = tabs.split.groups.findIndex((item) => item.activeId === tab.id);
                const badge =
                  group >= 0 && tabs.split.groups.length > 1 ? `[${group + 1}] ` : "";
                return {
                  label: `${badge}${tab.pinned ? "📌 " : ""}${tab.title || "新页签"}`,
                  type: "checkbox" as const,
                  checked: tab.id === tabs.activeId,
                  click: () => {
                    this.context.showWindow();
                    this.context.activateTab(tab.id);
                  },
                };
              })
          : [{ label: "（窗口未创建）", enabled: false }],
      },
      {
        label: "局域网地址",
        submenu:
          !this.context.isRemoteEnabled() || lan.length === 0
            ? [
                {
                  label: this.context.isRemoteEnabled() ? "（未找到局域网地址）" : "（未开启局域网访问）",
                  enabled: false,
                },
              ]
            : lan.map((item) => ({
                label: `${item.url}`,
                click: () => clipboard.writeText(item.url),
              })),
      },
      { type: "separator" },
      { label: "重启服务", click: () => this.context.restartServer() },
      { label: "设置…", click: () => this.context.openSettings() },
      { label: "打开日志", click: () => this.context.openLog() },
      { type: "separator" },
      { label: "退出并停止服务", click: () => this.context.quit() },
    ]);

    this.tray.setContextMenu(menu);
  }

  /** 服务启动失败：托盘气泡（不用 Windows toast，避免 Electron 生成带原子图标的开始菜单快捷方式） */
  showFailureBalloon(message: string): void {
    if (!this.exists || !this.tray) return;
    try {
      this.tray.displayBalloon({
        title: "Pi Web Desktop：服务启动失败",
        content: message.slice(0, 200),
      });
    } catch {
      // 某些系统/设置下不支持气泡通知
    }
  }

  /** 第一次最小化到托盘时提示一下，避免「以为已退出」 */
  showMinimizeBalloon(): void {
    if (!this.exists || !this.tray || this.balloonShown) return;
    this.balloonShown = true;
    try {
      this.tray.displayBalloon({
        title: "Pi Web Desktop 仍在运行",
        content: "窗口已最小化到托盘，pi-web 服务继续运行。要完全退出请点托盘图标 →「退出并停止服务」。",
      });
    } catch {
      // 某些系统/设置下不支持气泡通知
    }
  }
}
