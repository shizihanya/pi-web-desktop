# 上游问题调查：大文件在文件展开栏不显示 Git diff 详情

> 状态：**已定位，待决策**。本文只做本地记录与复现说明，**尚未提交上游 issue**。
> 记录日期：2026-11-23
> 归属结论：**pi-web 上游 v0.18.0 的硬性限制，与 pi-web-desktop 的改动无关**。
> 相关原则：上游零侵入（AGENTS.md），本文不包含任何修改上游源码的方案。

---

## 1. 结论速览

| 项 | 结论 |
|---|---|
| 现象 | 右侧文件展开栏中，部分已修改文件看不到 Git diff 详情 |
| 触发条件 | **文件自身大小 > 256 KiB**（`TEXT_PREVIEW_MAX_BYTES = 256 * 1024`） |
| 与改动量的关系 | **无关**。只改 1 行、diff 仅 1.9 KB 也会被拒绝 |
| 直接原因 | `GET /api/git/diff` 返回 `{ "supported": false }`，无 `patch` |
| 前端表现 | `hasGitDiff === false` → 模式栏不出现 `Diff` 按钮；若当时正处于 diff 模式则自动切回 `Source`，且无任何提示 |
| 是否「大文件需要分批显示」 | **不是**。`git diff` 接口整块返回 patch、没有分批参数；拒绝发生在执行 `git diff` 之前，判断的是文件大小而非 patch 大小 |
| 是否本项目改动引入 | **否**，见第 7 节 |

---

## 2. 环境

| 项 | 值 |
|---|---|
| pi-web | `@agegr/pi-web` **0.18.0**（全局安装，`C:\Users\weijia\AppData\Roaming\nvm\nodejs\node_modules\@agegr\pi-web`） |
| 运行实例 | `node bin/pi-web.js --no-open -p 30151 -H 127.0.0.1`（由 pi-web-desktop 拉起，纯原生 pi-web 服务） |
| OS | Windows 10 (10.0.19045) |
| Node | v22.22.1 |
| Git | 2.45.2.windows.1 |
| 宿主 | pi-web-desktop 0.1.0（仅 `loadURL` 托管页面） |
| 上游仓库 | https://github.com/agegr/pi-web ，issue 入口 https://github.com/agegr/pi-web/issues |

本次验证同时对照了本地另一份同版本安装（`nvm\v22.22.1\...\@agegr\pi-web`），两者均为 0.18.0，编译产物一致。

---

## 3. 原始现象

`sgs_web_week` 项目（`D:\work\sgs_web\sgs_web_week`）中两个均为 `M` 状态的文件：

- `src/mode/game/TableGameManager.ts` —— **看不到 git diff 详情**
- `src/seats/PlayerSeat.ts` —— **可以正常看到 diff 详情**

---

## 4. 复现步骤

### 4.1 真实项目复现（对正在运行的实例实测）

```powershell
$base = 'http://127.0.0.1:30151/api/git/diff'
$cwd  = 'D:\work\sgs_web\sgs_web_week'

foreach ($rel in @('src\mode\game\TableGameManager.ts', 'src\seats\PlayerSeat.ts')) {
  $path = Join-Path $cwd $rel
  $url  = "$base`?cwd=$([uri]::EscapeDataString($cwd))&path=$([uri]::EscapeDataString($path))"
  $r = Invoke-WebRequest -Uri $url -UseBasicParsing
  "$rel => HTTP $($r.StatusCode) $($r.Content)"
}
```

实测返回：

```
TableGameManager.ts => HTTP 200 {"supported":false}
PlayerSeat.ts       => HTTP 200 {"supported":true,"status":"modified","patch":"diff --git a/src/seats/PlayerSeat.ts ..."}
```

### 4.2 UI 复现

1. 打开 pi-web，进入 `sgs_web_week` 会话；
2. 在右侧文件栏分别展开 `TableGameManager.ts` 与 `PlayerSeat.ts`；
3. `PlayerSeat.ts` 的模式栏有 `Source / Diff`（可切到 Diff 看到 hunk）；
4. `TableGameManager.ts` 模式栏**没有 `Diff` 按钮**，只能看 Source，且无任何「文件过大」提示。

### 4.3 最小复现（不依赖用户项目，已实测）

在**pi-web 允许的根目录内**（见下方注意）建一个独立临时仓库，两个文件只差在大小，且都只改 1 行：

```bash
# 注意：仓库必须建在 pi-web 的 allowed roots 内（例如当前会话 cwd / project root），
# 否则 /api/git/diff 会先返回 403 "Access denied"。
mkdir pi-diff-repro && cd pi-diff-repro
git init -q

python3 - <<'PY'
from pathlib import Path
def mk(name, lines):
    Path(name).write_text("".join(f"line {i:05d} ".ljust(100, "x") + "\n" for i in range(1, lines + 1)))
mk("big.txt", 3000)     # 303000 B > 256 KiB
mk("small.txt", 2000)   # 202000 B < 256 KiB
PY

# 提交身份用 -c 随命令传入，不改全局或仓库配置
git add .
git -c user.name=repro -c user.email=repro@local commit -qm baseline

python3 - <<'PY'
from pathlib import Path
for n in ("big.txt", "small.txt"):
    p = Path(n); t = p.read_text()
    p.write_text("CHANGED ".ljust(100, "y") + "\n" + t.split("\n", 1)[1])
PY

# 两个文件都只改了第一行，diff 都只有 ~630 字符
for f in big.txt small.txt; do
  curl -sG "http://127.0.0.1:30151/api/git/diff" \
       --data-urlencode "cwd=$PWD" \
       --data-urlencode "path=$PWD/$f"
done
```

实测结果：

| 文件 | 大小 | `git diff` 输出 | API 返回 |
|---|---|---|---|
| `big.txt` | 303,000 B | 625 字符 | `{"supported":false}` |
| `small.txt` | 202,000 B | 633 字符 | `{"supported":true,"status":"modified","patch":"...","..."}`（patch 623 字符） |

最小复现已执行完毕，临时目录已删除，宿主项目 `git status --porcelain` 保持干净。

> 本地验证时用的是等价 PowerShell 脚本（在 `D:\person\pi-web-desktop\.pi-diff-repro` 下建独立仓库），结果同上。实测 `$env:TEMP`、`D:\work`、`C:\Users\weijia` 均返回 403，只有会话允许的目录（`D:\person\pi-web-desktop`、`D:\work\sgs_web\sgs_web_week`）可通过 —— 这是 `app/api/git/diff/route.ts` 的 `getAllowedFileRoots()` 校验，与本文问题无关，但复现时必须注意。

### 4.4 关键对照数据

| 文件 | 大小 | > 256 KiB | 含 NUL | `git diff --unified=3` 大小 | hunk 数 | API |
|---|---|---|---|---|---|---|
| `TableGameManager.ts` | 333,610 B | **是** | 否 | 1,894 B | 1 | `supported:false` |
| `PlayerSeat.ts` | 206,867 B | 否 | 否 | 2,535 B | 2 | `supported:true` |

`TableGameManager.ts` 的 diff 输出仅 1.9 KB、1 个 hunk，远低于任何「输出过大」阈值 —— 进一步说明拒绝发生在**执行 diff 之前**，且依据是**文件大小**。

---

## 5. 根因定位（pi-web 上游源码）

### 5.1 服务端：`getGitFileDiff()` 的 256 KiB 门槛

`app/api/git/diff/route.ts` 只做路径校验，实际逻辑在 `lib/git-changes.ts` 的 `getGitFileDiff(cwd, filePath)`：

```ts
// lib/file-types.ts
export const TEXT_PREVIEW_MAX_BYTES = 256 * 1024;   // 262144
```

```ts
// lib/git-changes.ts  （命中处）
let stat: fs.Stats;
try {
  stat = fs.lstatSync(resolvedFilePath);
} catch {
  return { supported: false };
}
if (!stat.isFile() || stat.size > TEXT_PREVIEW_MAX_BYTES) return { supported: false };  // ← 本次命中

const currentBuffer = fs.readFileSync(resolvedFilePath);
if (hasNullByte(currentBuffer)) return { supported: false };
...
if (!patch.includes("\n@@ ")) return { supported: false };
return { supported: true, status, patch };
```

全部 `supported:false` 分支（备查）：

1. 找不到仓库 / 文件不在仓库内 / `git status` 里找不到该路径；
2. **`stat.size > TEXT_PREVIEW_MAX_BYTES`（256 KiB）** ← 本次；
3. 文件含 NUL 字节（按二进制处理）；
4. `createTrackedFilePatch()` 内 `git diff` 的 `maxBuffer = TEXT_PREVIEW_MAX_BYTES * 4 = 1 MiB`，输出超限会被 `catch` 成 `null`，非 `added` 状态即返回 false；
5. 最终 patch 不包含 `"\n@@ "`（无 hunk）也返回 false。

本地编译产物交叉验证：`.next/server/app/api/git/diff/route.js` 中 `d = 262144`，`D()` 内 `if(!c.isFile()||c.size>k._4)return{supported:!1}`，`B()` 的 `maxBuffer = 4*k._4`。

### 5.2 前端：`components/FileViewer.tsx` 静默丢弃

```tsx
// fetchGitDiff()
const next = await response.json() as GitFileDiffResponse & { error?: string };
setGitDiff(response.ok && next.supported && typeof next.patch === "string" ? next : null);

const hasGitDiff = gitDiff?.supported === true && typeof gitDiff.patch === "string";

// 加载完成后若当前是 diff 模式但不可用，静默退回 source
useEffect(() => {
  if (gitDiffResolved && !hasGitDiff && displayMode === "diff") updateDisplayMode("source");
}, [displayMode, gitDiffResolved, hasGitDiff, updateDisplayMode]);

// 模式栏：只有 hasGitDiff 为 true 才出现 Diff 按钮
const displayModes: DisplayMode[] = isDeletedDiff
  ? ["diff"]
  : ["source", ...(hasPreview ? ["preview" as const] : []), ...(hasGitDiff ? ["diff" as const] : [])];
```

`supported:false` 时 `gitDiff` 被置为 `null`，`hasGitDiff === false`：既没有 Diff 按钮，也没有「文件过大」之类的说明，用户只看到「详情没了」。

### 5.3 与「分批显示」猜测的区别

- `/api/files/...?type=read&offset=...` 确实支持分块读取**源码内容**（`FileViewer` 的 `fetchContent(offset)` / Load more）；
- 但 `/api/git/diff` **没有 offset/limit/分批参数**，一次性返回整段 patch；
- 且 5.1 的文件大小检查在任何 git 命令之前，因此「改动多、需要分批」不会是原因，**文件大**才是。

---

## 6. 影响范围

- 任何自身体积超过 256 KiB 的受版本控制文本文件，`Diff` 视图整体不可用，无论改动多小；
- 大型源码文件（本项目 `TableGameManager.ts`、`PlayerSeat.ts` 这类单文件几百 KB 的 TS 很常见）尤其容易踩到；
- 次要：diff 输出超过 1 MiB 的文件也会因 `maxBuffer` 被拒；
- 前端无任何失败提示，属于静默降级，用户容易误判为「diff 功能坏了 / 桌面客户端改坏了」。

---

## 7. 排除 pi-web-desktop 的依据

| 检查 | 结果 |
|---|---|
| `src/` 全量搜索 `git diff` / `diff` / `patch` 相关实现 | 无。桌面层没有实现或代理任何文件 diff 功能 |
| 网络拦截 | 无 `webRequest` / `onBeforeRequest` / `protocol.handle` / 响应改写；桌面不碰 pi-web 的 HTTP 流量 |
| 页面注入 | 仅只读探针与补丁：`tab-status` / `theme-probe` / `notification-patch` / `composer-bridge` / `draft-workspace`，全部与文件查看器无关 |
| 进程模型 | pi-web 是独立 `node` 进程（`next start -p 30151`），桌面只做 `loadURL` 与接管 `window.open` |
| 实测 | 直接请求原生 `/api/git/diff` 即可稳定复现，响应体来自上游 `getGitFileDiff()` |

结论：**上游零侵入前提下，桌面层没有、也不应有改动会导致该现象**。

---

## 8. 可选处理方向（均未实施，待决策）

**A. 向上游反馈（推荐，治本）**

建议要点：

- 把 diff 的大小限制从「**文件自身大小**」改为「**生成的 patch 大小**」；`TEXT_PREVIEW_MAX_BYTES` 是文本预览上限，直接复用到 diff 上并不合适；
- 或为 diff 引入独立常量（如 10 MiB，与 `IMAGE/DOCX/HTML_PREVIEW_MAX_BYTES` 同量级），并同步放大 `createTrackedFilePatch()` 的 `maxBuffer`；
- 或给 `/api/git/diff` 增加 `reason` 字段（如 `file_too_large`、`patch_too_large`、`binary`），让 `FileViewer` 显示明确提示而不是静默隐藏 Diff 按钮；
- 服务端其实只需 `lstat` + `git diff`，并不读取整文件内容（除了 untracked/added 分支），按文件大小拒绝并无必要。

**B. 用户侧临时绕过（不改任何代码）**

- 在 pi-web 内置终端里 `git diff -- <file>` 查看；
- 或对超大源文件做业务拆分。

**C. 桌面侧独立增强（需单独评估，不优先）**

主进程直接执行 `git diff`、用 Electron 独立窗口/页签渲染 patch，完全不侵入 pi-web 页面。属于新增功能而非修复上游缺陷，需按 AGENTS.md 做必要性评估、兼容性检测与安全降级设计；本文不展开。

---

## 9. 待提交 issue 草稿（**未提交**，供后续审阅后使用）

> 以下为英文草稿，路径/端口已用占位符替换，确认后再提交到 https://github.com/agegr/pi-web/issues 。
> 本文档的其余章节为内部记录，不属于 issue 正文。

---

**Title:** File viewer: Git diff is silently unavailable for files larger than 256 KiB, even when the diff is a single line

**Environment**

- pi-web `@agegr/pi-web` 0.18.0
- Node v22.22.1, Windows 10 (10.0.19045), Git 2.45.2.windows.1
- Reproduced against a stock pi-web server via its own HTTP API (`GET /api/git/diff`); no third-party patches to pi-web.

**Summary**

`GET /api/git/diff` returns `{ "supported": false }` for any tracked text file whose **own size** exceeds `TEXT_PREVIEW_MAX_BYTES` (256 KiB). The check happens before `git diff` runs, so even a one-line change that produces a ~600-byte patch is rejected. `FileViewer` then silently hides the `Diff` tab (or falls back to `Source`) with no message to the user.

**Steps to reproduce**

1. In a git repository that pi-web can access, create two tracked text files:
   - `big.txt` = 3000 lines x 101 bytes = 303,000 B (> 256 KiB)
   - `small.txt` = 2000 lines x 101 bytes = 202,000 B (< 256 KiB)
2. Commit them, then change exactly **one line** in each (both diffs are ~630 bytes).
3. Request the diff for each file:

   ```bash
   curl -sG "http://<host>:<port>/api/git/diff" \
        --data-urlencode "cwd=$PWD" \
        --data-urlencode "path=$PWD/big.txt"
   ```

   (The repo must be inside pi-web's allowed roots; an outside path returns 403 by design.)

4. Open both files in the right-hand file viewer and compare the view-mode buttons.

**Actual**

| File | Size | `git diff --unified=3` | API |
|---|---|---|---|
| `big.txt` | 303,000 B | 625 chars, 1 hunk | `{"supported":false}` |
| `small.txt` | 202,000 B | 633 chars, 1 hunk | `{"supported":true,"status":"modified","patch":"..."}` |

`big.txt` has no `Diff` button. A real-world case: `TableGameManager.ts` (333,610 B, diff 1,894 B, 1 hunk) shows no diff, while `PlayerSeat.ts` (206,867 B) shows it correctly.

**Expected**

The diff view should be available when the **patch** is small and renderable, regardless of the file's total size; or at minimum the UI should explain why the diff is unavailable.

**Root cause**

- `lib/file-types.ts`: `TEXT_PREVIEW_MAX_BYTES = 256 * 1024`.
- `lib/git-changes.ts`, `getGitFileDiff()`:

  ```ts
  if (!stat.isFile() || stat.size > TEXT_PREVIEW_MAX_BYTES) return { supported: false };
  ```

  This reuses the **text preview** ceiling as a **diff** ceiling. Related secondary limit: `createTrackedFilePatch()` passes `TEXT_PREVIEW_MAX_BYTES * 4` (1 MiB) as `execFile` `maxBuffer`, so large patches also fail silently.
- `components/FileViewer.tsx`:

  ```tsx
  setGitDiff(response.ok && next.supported && typeof next.patch === "string" ? next : null);
  const hasGitDiff = gitDiff?.supported === true && typeof gitDiff.patch === "string";
  // displayModes only includes "diff" when hasGitDiff is true
  ```

  `supported: false` produces no user-visible feedback.

**Suggested fix**

- Gate the diff on the **generated patch size** (or a dedicated, larger `GIT_DIFF_MAX_BYTES` constant) instead of the source file size, and size the `git diff` `maxBuffer` accordingly.
- Optionally return a `reason` (`file_too_large` / `patch_too_large` / `binary`) so the viewer can show an explicit message instead of silently dropping the tab.
- For tracked files the server only needs `lstat` + `git diff`; it does not need the whole working-copy content, so the file-size guard adds little protection here.

**Note on chunking**

`/api/files/...?type=read&offset=` already supports chunked source reads, but `/api/git/diff` has no pagination and the rejection occurs before `git diff` is invoked, so this is not a "large diff needs batching" issue.

---

## 10. 附：本次验证清单

- [x] 桌面层 `src/` 全量搜索 diff / 网络拦截 / 注入点
- [x] 定位上游编译产物 `.next/server/app/api/git/diff/route.js` 与前端 chunk `.next/static/chunks/app/page-*.js`
- [x] 对照上游源码 `app/api/git/diff/route.ts`、`lib/git-changes.ts`、`lib/file-types.ts`、`components/FileViewer.tsx`
- [x] 实测真实项目两个文件的 `/api/git/diff` 返回
- [x] 实测文件大小、NUL 字节、`git diff --unified=3` 输出与 hunk 数
- [x] 独立临时仓库最小复现（大/小对照，均只改 1 行），临时目录已清理
- [x] 宿主项目 `git status` 未被污染
- [ ] 决策：是否提交上游 issue / 是否做桌面侧独立 diff 增强
