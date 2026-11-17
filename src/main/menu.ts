import { app, Menu, type MenuItemConstructorOptions } from "electron";
import type { SplitPreset } from "../shared/split";

export interface MenuContext {
  newTab: () => void;
  closeTab: () => void;
  setSplit: (preset: SplitPreset) => void;
  splitRight: () => void;
  closeGroup: () => void;
  reload: () => void;
  devTools: () => void;
  zoom: (direction: "in" | "out" | "reset") => void;
  toggleFullScreen: () => void;
  openSettings: () => void;
  restartServer: () => void;
  openLog: () => void;
  openDataFolder: () => void;
  showServerStatus: () => void;
  checkUpdates: () => void;
  showAbout: () => void;
}

/**
 * 说明：快捷键统一由 main 的 before-input-event 处理，
 * 菜单里的 accelerator 只作提示（不加 accelerator 字段），避免双触发。
 */
export function installAppMenu(context: MenuContext): void {
  const template: MenuItemConstructorOptions[] = [
    {
      label: "文件",
      submenu: [
        { label: "新页签\tCtrl+T", click: () => context.newTab() },
        { label: "关闭页签\tCtrl+W", click: () => context.closeTab() },
        { type: "separator" },
        { label: "设置…", click: () => context.openSettings() },
        { type: "separator" },
        { label: "退出", click: () => app.quit() },
      ],
    },
    {
      label: "编辑",
      submenu: [
        { role: "undo", label: "撤销" },
        { role: "redo", label: "重做" },
        { type: "separator" },
        { role: "cut", label: "剪切" },
        { role: "copy", label: "复制" },
        { role: "paste", label: "粘贴" },
        { role: "selectAll", label: "全选" },
      ],
    },
    {
      label: "视图",
      submenu: [
        { label: "重新加载\tCtrl+R", click: () => context.reload() },
        { type: "separator" },
        { label: "放大\tCtrl++", click: () => context.zoom("in") },
        { label: "缩小\tCtrl+-", click: () => context.zoom("out") },
        { label: "实际大小\tCtrl+0", click: () => context.zoom("reset") },
        { type: "separator" },
        { label: "全屏\tF11", click: () => context.toggleFullScreen() },
        { label: "开发者工具\tF12", click: () => context.devTools() },
        { type: "separator" },
        { label: "单栏\tCtrl+Alt+1", click: () => context.setSplit("single") },
        { label: "左右双栏\tCtrl+Alt+2", click: () => context.setSplit("columns-2") },
        { label: "上下双栏", click: () => context.setSplit("rows-2") },
        { label: "三栏\tCtrl+Alt+3", click: () => context.setSplit("columns-3") },
        { label: "四宫格\tCtrl+Alt+4", click: () => context.setSplit("grid-2x2") },
        { type: "separator" },
        { label: "向右拆分\tCtrl+\\", click: () => context.splitRight() },
        { label: "关闭当前窗格\tCtrl+Shift+\\", click: () => context.closeGroup() },
      ],
    },
    {
      label: "服务",
      submenu: [
        { label: "状态", click: () => context.showServerStatus() },
        { label: "重启服务", click: () => context.restartServer() },
        { type: "separator" },
        { label: "打开日志", click: () => context.openLog() },
        { label: "打开数据目录", click: () => context.openDataFolder() },
        { type: "separator" },
        { label: "检查 pi-web 更新…", click: () => context.checkUpdates() },
      ],
    },
    {
      label: "帮助",
      submenu: [{ label: "关于 Pi Web Desktop", click: () => context.showAbout() }],
    },
  ];

  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}
