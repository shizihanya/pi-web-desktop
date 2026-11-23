import { app, BrowserWindow, ipcMain, shell, type WebContents } from "electron";
import { DRAFT_IPC, IPC, NOTIFICATION_IPC, TAB_IPC } from "../shared/types";
import type { DraftWorkspace } from "./tabs/draft-workspace";
import type { SplitPreset } from "../shared/split";
import type { DropSide } from "../shared/split-model";
import type { DropPreview } from "../shared/types";
import type { ServerManager } from "./server/server-manager";
import type { TabManager } from "./tabs/tab-manager";
import { dataDir, logFilePath } from "./settings";

export interface IpcContext {
  manager: ServerManager;
  /** 服务就绪后的回调（首次启动 / 手动重试都走这里） */
  onReady: (url: string) => void;
}

export function registerIpc(context: IpcContext): void {
  const { manager, onReady } = context;

  ipcMain.handle(IPC.getState, () => manager.getState());
  ipcMain.handle(IPC.getLogs, () => manager.logs());

  ipcMain.handle(IPC.retry, async () => {
    const state = await manager.restart();
    if (state.phase === "ready" && state.url) onReady(state.url);
    return state;
  });

  ipcMain.handle(IPC.openLogFile, async () => {
    const result = await shell.openPath(logFilePath());
    if (result) manager.log(`[shell] 打开日志失败：${result}`);
  });

  ipcMain.handle(IPC.openDataFolder, async () => {
    await shell.openPath(dataDir());
  });

  ipcMain.handle(IPC.quit, () => {
    app.quit();
  });

  manager.onState((state) => {
    for (const win of BrowserWindow.getAllWindows()) {
      if (!win.isDestroyed()) win.webContents.send(IPC.stateEvent, state);
    }
  });

  manager.onLog((line) => {
    for (const win of BrowserWindow.getAllWindows()) {
      if (!win.isDestroyed()) win.webContents.send(IPC.logEvent, line);
    }
  });
}

/** Windows 通知点击：只把来源 WebContents 交给主进程，不接收 Renderer 传入的 Tab ID。 */
export function registerNotificationIpc(onClicked: (sender: WebContents) => void): void {
  ipcMain.on(NOTIFICATION_IPC.clicked, (event) => {
    if (event.sender.isDestroyed()) return;
    onClicked(event.sender);
  });
}

/**
 * 独立输入工作区 IPC：面板渲染层 ↔ DraftWorkspace。
 * 面板渲染层只拿到快照 / 发送结果，拿不到任何 WebContents 或 Node 能力。
 */
export function registerDraftIpc(provider: () => DraftWorkspace | null): void {
  const withDrafts = <T>(fn: (workspace: DraftWorkspace) => T): T | null => {
    const workspace = provider();
    return workspace ? fn(workspace) : null;
  };

  ipcMain.handle(DRAFT_IPC.get, () => withDrafts((drafts) => drafts.snapshot()));
  ipcMain.handle(DRAFT_IPC.setText, (_event, text: string) =>
    withDrafts((drafts) => drafts.setText(typeof text === "string" ? text : "")),
  );
  ipcMain.handle(DRAFT_IPC.open, () => withDrafts((drafts) => drafts.open()));
  ipcMain.handle(DRAFT_IPC.close, () => withDrafts((drafts) => drafts.close()));
  ipcMain.handle(DRAFT_IPC.toggle, () => withDrafts((drafts) => drafts.toggle()));
  ipcMain.handle(DRAFT_IPC.setWidth, (_event, px: number) =>
    withDrafts((drafts) => drafts.setWidth(Number(px))),
  );
  ipcMain.handle(DRAFT_IPC.addImages, (_event, images: unknown) =>
    withDrafts((drafts) =>
      drafts.addImages(
        (Array.isArray(images) ? images : []).filter(
          (item): item is { data: string; mimeType: string; name: string } =>
            Boolean(item) &&
            typeof (item as { data?: unknown }).data === "string" &&
            typeof (item as { mimeType?: unknown }).mimeType === "string",
        ),
      ),
    ),
  );
  ipcMain.handle(DRAFT_IPC.removeImage, (_event, id: string) =>
    withDrafts((drafts) => drafts.removeImage(String(id))),
  );
  ipcMain.handle(DRAFT_IPC.getImage, (_event, id: string) =>
    withDrafts((drafts) => drafts.getImage(String(id))) ?? null,
  );
  ipcMain.handle(DRAFT_IPC.openInNative, (_event) =>
    withDrafts((drafts) => drafts.openInNative()) ??
    ({ ok: false, reason: "独立输入工作区尚未就绪" } as const),
  );
  ipcMain.handle(DRAFT_IPC.send, () =>
    withDrafts((drafts) => drafts.send()) ??
    ({ ok: false, reason: "独立输入工作区尚未就绪" } as const),
  );
}

/**
 * 页签相关 IPC：页签栏 UI ↔ TabManager。
 * 用 provider 而不是直接传实例，方便窗口重建 / 多窗口时复用同一组 handler。
 */
export function registerTabIpc(
  provider: () => TabManager | null,
  openSettings: () => void,
): void {
  const withTabs = <T>(fn: (tabs: TabManager) => T): T | null => {
    const tabs = provider();
    return tabs ? fn(tabs) : null;
  };

  ipcMain.handle(TAB_IPC.list, () => withTabs((tabs) => tabs.snapshot()));
  ipcMain.handle(TAB_IPC.open, (_event, path?: string) => withTabs((tabs) => tabs.createTab(path)));
  ipcMain.handle(TAB_IPC.close, (_event, id: string) => withTabs((tabs) => tabs.closeTab(id)));
  ipcMain.handle(TAB_IPC.activate, (_event, id: string) => withTabs((tabs) => tabs.activate(id)));
  ipcMain.handle(TAB_IPC.move, (_event, id: string, index: number) =>
    withTabs((tabs) => tabs.move(id, index)),
  );
  ipcMain.handle(TAB_IPC.setPinned, (_event, id: string, pinned: boolean) =>
    withTabs((tabs) => tabs.setPinned(id, pinned)),
  );
  ipcMain.handle(TAB_IPC.showMenu, (_event, id: string, x: number, y: number) =>
    withTabs((tabs) => tabs.showMenu(id, x, y)),
  );
  ipcMain.handle(TAB_IPC.reloadCrashed, (_event, id: string) =>
    withTabs((tabs) => tabs.reloadCrashed(id)),
  );
  ipcMain.handle(TAB_IPC.openSettings, () => {
    openSettings();
  });

  /* ---- 分屏 ---- */
  ipcMain.handle(TAB_IPC.setSplit, (_event, preset: SplitPreset) =>
    withTabs((tabs) => tabs.setSplitPreset(preset)),
  );
  ipcMain.handle(TAB_IPC.splitWith, (_event, id: string, orientation?: "columns" | "rows") =>
    withTabs((tabs) => tabs.splitWithTab(id, orientation)),
  );
  ipcMain.handle(TAB_IPC.focusGroup, (_event, index: number) =>
    withTabs((tabs) => tabs.focusGroup(index)),
  );
  ipcMain.handle(TAB_IPC.closeGroup, (_event, index: number) =>
    withTabs((tabs) => tabs.closeGroup(index)),
  );
  ipcMain.handle(TAB_IPC.newTabInGroup, (_event, index: number) =>
    withTabs((tabs) => tabs.newTabInGroup(index)),
  );
  ipcMain.handle(TAB_IPC.moveTabToGroup, (_event, id: string, groupIndex: number, insertIndex?: number) =>
    withTabs((tabs) => tabs.moveTabToGroup(id, groupIndex, insertIndex)),
  );
  ipcMain.handle(TAB_IPC.splitTabToEdge, (_event, id: string, side: "left" | "right") =>
    withTabs((tabs) => tabs.splitTabToEdge(id, side)),
  );
  ipcMain.handle(TAB_IPC.beginTabDrag, () => withTabs((tabs) => tabs.beginTabDrag()));
  ipcMain.handle(TAB_IPC.endTabDrag, () => withTabs((tabs) => tabs.endTabDrag()));
  /* ---- 分隔条拖动（M2）---- */
  ipcMain.handle(TAB_IPC.beginSashDrag, (_event, splitId: string) =>
    withTabs((tabs) => tabs.beginSashDrag(String(splitId ?? ""))),
  );
  ipcMain.handle(TAB_IPC.setSashRatio, (_event, splitId: string, x: number, y: number, stamp: number) =>
    withTabs((tabs) =>
      tabs.setSashRatio(
        String(splitId ?? ""),
        Number(x) || 0,
        Number(y) || 0,
        Number.isFinite(Number(stamp)) ? Number(stamp) : Date.now(),
      ),
    ),
  );
  ipcMain.handle(TAB_IPC.endSashDrag, () => withTabs((tabs) => tabs.endSashDrag()));
  /* ---- 五方向拖拽（M3）---- */
  const dropSides: DropSide[] = ["center", "left", "right", "top", "bottom"];
  const cleanSide = (side: unknown): DropSide =>
    dropSides.includes(side as DropSide) ? (side as DropSide) : "center";
  const emptyPreview: DropPreview = {
    allowed: false,
    reason: "页签尚未就绪",
    side: "center",
    targetPaneId: "",
    destinationPaneId: "",
    createsPane: false,
    paneCount: 0,
    panes: [],
    sashes: [],
  };
  ipcMain.handle(TAB_IPC.previewTabDrop, (_event, id: string, targetPaneId: string, side: DropSide, insertIndex?: number) =>
    withTabs((tabs) =>
      tabs.previewTabDrop(
        String(id ?? ""),
        String(targetPaneId ?? ""),
        cleanSide(side),
        typeof insertIndex === "number" && Number.isFinite(insertIndex) ? insertIndex : undefined,
      ),
    ) ?? emptyPreview,
  );
  ipcMain.handle(TAB_IPC.dropTab, (_event, id: string, targetPaneId: string, side: DropSide, insertIndex?: number) =>
    withTabs((tabs) =>
      tabs.dropTab(
        String(id ?? ""),
        String(targetPaneId ?? ""),
        cleanSide(side),
        typeof insertIndex === "number" && Number.isFinite(insertIndex) ? insertIndex : undefined,
      ),
    ),
  );
  ipcMain.handle(TAB_IPC.showSplitMenu, (_event, x: number, y: number) =>
    withTabs((tabs) => tabs.showSplitMenu(x, y)),
  );
  ipcMain.handle(TAB_IPC.showGroupMenu, (_event, index: number, x: number, y: number) =>
    withTabs((tabs) => tabs.showGroupMenu(index, x, y)),
  );
}
