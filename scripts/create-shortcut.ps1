# 生成启动快捷方式（项目 / 桌面 / 开始菜单），并维护 Windows 任务栏图标
#
# 用法：
#   npm run shortcut            # 项目根目录（桌面上已有同名快捷方式时一并刷新）
#   npm run shortcut:desktop    # 同时放一份到桌面
#
# 主进程用 app.setAppUserModelId("com.local.piweb.desktop") 声明 AUMID；
# Windows 任务栏会按它去开始菜单找带同 ID 的快捷方式并用其图标（会覆盖窗口 icon）。
# 所以这里保证：开始菜单里只有一个该 AUMID 的快捷方式，且它指向官方 electron.exe、
# 带启动参数、图标 = build/icon.ico。托盘图标由应用自己创建，不经过 AUMID。
# 同时写入固定的 ToastActivatorCLSID（与主进程 app.setToastActivatorCLSID 一致），
# 让 Windows toast 通知在应用重启后仍可正常激活。

param(
  [switch]$Desktop
)

$ErrorActionPreference = "Stop"

$root = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
$appId = "com.local.piweb.desktop"
$toastClsid = "{5477A902-2108-4059-A5D0-F6FEAFF61562}"
$exe = Join-Path $root "node_modules\electron\dist\electron.exe"
$main = "out\main\index.js"
$icon = Join-Path $root "build\icon.ico"
if (-not (Test-Path $icon)) { $icon = Join-Path $root "build\icon.png" }
$target = Join-Path $root "Pi Web Desktop.lnk"
$startMenu = Join-Path ([Environment]::GetFolderPath("StartMenu")) "Programs"
$startMenuLnk = Join-Path $startMenu "Pi Web Desktop.lnk"

if (-not (Test-Path $exe)) {
  throw "找不到 $exe`n先执行：npm install（或 node node_modules/electron/install.js）"
}
if (-not (Test-Path (Join-Path $root $main))) {
  Write-Output "警告：还没有构建产物 $main，快捷方式会启动失败。先运行 npm run build（或 npm run app）。"
}

# WScript.Shell 不能写 .lnk 的 System.AppUserModel.ID，只能走 COM
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;

namespace PiWebDesktop {
  [StructLayout(LayoutKind.Sequential)]
  public struct PropertyKey { public Guid fmtid; public uint pid; }

  [StructLayout(LayoutKind.Sequential)]
  public struct PropVariant {
    public ushort vt;
    public ushort wReserved1;
    public ushort wReserved2;
    public ushort wReserved3;
    public IntPtr p;
    public int p2;
  }

  [ComImport, Guid("886D8EEB-8CF2-4446-8D02-CDBA1DBDCF99"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  public interface IPropertyStore {
    [PreserveSig] int GetCount(out uint count);
    [PreserveSig] int GetAt(uint index, out PropertyKey key);
    [PreserveSig] int GetValue(ref PropertyKey key, out PropVariant pv);
    [PreserveSig] int SetValue(ref PropertyKey key, ref PropVariant pv);
    [PreserveSig] int Commit();
  }

  [ComImport, Guid("0000010B-0000-0000-C000-000000000046"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  public interface IPersistFile {
    [PreserveSig] int GetClassID(out Guid clsid);
    [PreserveSig] int IsDirty();
    [PreserveSig] int Load([MarshalAs(UnmanagedType.LPWStr)] string file, uint mode);
    [PreserveSig] int Save([MarshalAs(UnmanagedType.LPWStr)] string file, [MarshalAs(UnmanagedType.Bool)] bool remember);
    [PreserveSig] int SaveCompleted([MarshalAs(UnmanagedType.LPWStr)] string file);
    [PreserveSig] int GetCurFile(out IntPtr file);
  }

  public static class ShortcutAppId {
    static readonly Guid FMTID = new Guid("9F4C2855-9F79-4B39-A8D0-E1D42DE1D5F3");

    public static void Set(string path, string appId, string toastClsid) {
      object link = Activator.CreateInstance(Type.GetTypeFromCLSID(new Guid("00021401-0000-0000-C000-000000000046")));
      IntPtr unk = IntPtr.Zero, pfPtr = IntPtr.Zero, psPtr = IntPtr.Zero, str = IntPtr.Zero, clsidMem = IntPtr.Zero;
      try {
        unk = Marshal.GetIUnknownForObject(link);

        Guid iidPersistFile = new Guid("0000010B-0000-0000-C000-000000000046");
        int hr = Marshal.QueryInterface(unk, ref iidPersistFile, out pfPtr);
        if (hr != 0) throw new Exception("QI IPersistFile: 0x" + hr.ToString("X8"));
        IPersistFile pf = (IPersistFile)Marshal.GetTypedObjectForIUnknown(pfPtr, typeof(IPersistFile));
        hr = pf.Load(path, 2); // STGM_READWRITE
        if (hr != 0) throw new Exception("IPersistFile.Load: 0x" + hr.ToString("X8"));

        Guid iidPropertyStore = new Guid("886D8EEB-8CF2-4446-8D02-CDBA1DBDCF99");
        hr = Marshal.QueryInterface(unk, ref iidPropertyStore, out psPtr);
        if (hr != 0) throw new Exception("QI IPropertyStore: 0x" + hr.ToString("X8"));
        IPropertyStore ps = (IPropertyStore)Marshal.GetTypedObjectForIUnknown(psPtr, typeof(IPropertyStore));

        // PKEY_AppUserModel_ID, pid 5, VT_LPWSTR
        PropertyKey keyId = new PropertyKey { fmtid = FMTID, pid = 5 };
        str = Marshal.StringToCoTaskMemUni(appId);
        PropVariant pvId = new PropVariant { vt = 31 /* VT_LPWSTR */, p = str };
        hr = ps.SetValue(ref keyId, ref pvId);
        if (hr != 0 && hr != 1) throw new Exception("IPropertyStore.SetValue(AppUserModel_ID): 0x" + hr.ToString("X8"));

        // PKEY_AppUserModel_ToastActivatorCLSID, pid 26, VT_CLSID
        PropertyKey keyClsid = new PropertyKey { fmtid = FMTID, pid = 26 };
        Guid parsed = new Guid(toastClsid);
        clsidMem = Marshal.AllocCoTaskMem(16);
        Marshal.Copy(parsed.ToByteArray(), 0, clsidMem, 16);
        PropVariant pvClsid = new PropVariant { vt = 72 /* VT_CLSID */, p = clsidMem };
        hr = ps.SetValue(ref keyClsid, ref pvClsid);
        if (hr != 0 && hr != 1) throw new Exception("IPropertyStore.SetValue(ToastActivatorCLSID): 0x" + hr.ToString("X8"));

        hr = ps.Commit();
        if (hr != 0 && hr != 1) throw new Exception("IPropertyStore.Commit: 0x" + hr.ToString("X8"));
        hr = pf.Save(path, true);
        if (hr != 0 && hr != 1) throw new Exception("IPersistFile.Save: 0x" + hr.ToString("X8"));
      } finally {
        if (clsidMem != IntPtr.Zero) Marshal.FreeCoTaskMem(clsidMem);
        if (str != IntPtr.Zero) Marshal.FreeCoTaskMem(str);
        if (psPtr != IntPtr.Zero) Marshal.Release(psPtr);
        if (pfPtr != IntPtr.Zero) Marshal.Release(pfPtr);
        if (unk != IntPtr.Zero) Marshal.Release(unk);
      }
    }
  }

  public static class ShellRefresh {
    [DllImport("shell32.dll")] public static extern void SHChangeNotify(int eventId, uint flags, IntPtr item1, IntPtr item2);
  }
}
'@

$wsh = New-Object -ComObject WScript.Shell
$shellApp = New-Object -ComObject Shell.Application

function New-AppShortcut([string]$path) {
  if (Test-Path $path) { Remove-Item $path -Force }
  $lnk = $wsh.CreateShortcut($path)
  $lnk.TargetPath = $exe
  $lnk.Arguments = $main
  $lnk.WorkingDirectory = $root
  $lnk.IconLocation = "$icon,0"
  $lnk.Description = "Pi Web Desktop — 自动启动 pi-web 并用页签打开"
  $lnk.WindowStyle = 1
  $lnk.Save()
  try {
    [PiWebDesktop.ShortcutAppId]::Set($path, $appId, $toastClsid)
  } catch {
    Write-Output "警告：无法给 $path 写入 AUMID 属性（$($_.Exception.Message)），任务栏会回落到窗口 icon。"
  }
  Write-Output "已生成：$path"
}

# 开始菜单里只保留一个该 AUMID 的注册点：全部清掉再重建，避免历史残留（Electron.lnk 等）
if (Test-Path $startMenu) {
  $ns = $shellApp.Namespace($startMenu)
  Get-ChildItem $startMenu -Filter "*.lnk" -File -ErrorAction SilentlyContinue | ForEach-Object {
    try {
      $item = $ns.ParseName($_.Name)
      if ($null -eq $item) { return }
      if ($item.ExtendedProperty("System.AppUserModel.ID") -eq $appId) {
        Write-Output "移除旧注册点：$($_.Name)"
        Remove-Item $_.FullName -Force
      }
    } catch {
      Write-Output "警告：检查开始菜单快捷方式 $($_.Name) 失败：$($_.Exception.Message)"
    }
  }
}

New-AppShortcut $target
$desktopLnk = Join-Path ([Environment]::GetFolderPath("Desktop")) "Pi Web Desktop.lnk"
if ($Desktop -or (Test-Path $desktopLnk)) { New-AppShortcut $desktopLnk }
if (Test-Path $startMenu) { New-AppShortcut $startMenuLnk }

[PiWebDesktop.ShellRefresh]::SHChangeNotify(0x08000000, 0, [IntPtr]::Zero, [IntPtr]::Zero)
Write-Output "AUMID：$appId；ToastActivatorCLSID：$toastClsid（均与主进程一致）；图标：$icon"
