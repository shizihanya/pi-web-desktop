import { appendFileSync, existsSync, mkdirSync, renameSync, rmSync, statSync } from "node:fs";
import { dirname } from "node:path";

const MAX_LINES = 500;
const MAX_FILE_BYTES = 2 * 1024 * 1024;

/**
 * 服务日志：内存环形缓冲（给 splash 实时展示）+ 追加写到 data/server.log。
 */
export class ServerLogger {
  private buffer: string[] = [];
  private readonly listeners = new Set<(line: string) => void>();

  constructor(private readonly file: string) {
    mkdirSync(dirname(file), { recursive: true });
    this.rotateIfNeeded();
  }

  /** 测试期天天开着，日志别无限长：超过 2MB 就换成 server.1.log */
  private rotateIfNeeded(): void {
    try {
      if (!existsSync(this.file)) return;
      if (statSync(this.file).size < MAX_FILE_BYTES) return;
      const backup = this.file.replace(/\.log$/, ".1.log");
      rmSync(backup, { force: true });
      renameSync(this.file, backup);
    } catch {
      // 轮转失败不影响使用
    }
  }

  onLine(listener: (line: string) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  write(line: string): void {
    const text = line.replace(/\r?\n$/, "");
    if (text.length === 0) return;
    const stamped = `${new Date().toISOString()} ${text}`;
    this.buffer.push(stamped);
    if (this.buffer.length > MAX_LINES) {
      this.buffer.splice(0, this.buffer.length - MAX_LINES);
    }
    for (const listener of this.listeners) {
      try {
        listener(stamped);
      } catch {
        // 渲染进程可能已经退出，忽略
      }
    }
    try {
      if (existsSync(this.file) && statSync(this.file).size > MAX_FILE_BYTES) this.rotateIfNeeded();
      appendFileSync(this.file, `${stamped}\n`, "utf8");
    } catch {
      // 磁盘问题不应该影响服务启动
    }
  }

  writeChunk(chunk: string): void {
    for (const line of chunk.split(/\r?\n/)) this.write(line);
  }

  lines(): string[] {
    return [...this.buffer];
  }

  tail(count: number): string {
    return this.buffer.slice(-count).join("\n");
  }
}
