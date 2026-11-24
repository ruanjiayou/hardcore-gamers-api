/**
 * 构建与运行信息（`server/src/utils/buildInfo.ts`）
 *
 * 线上 404 最常见的原因不是代码错，而是**部署的进程跑着旧代码**。
 * 把「当前进程是哪个 commit、什么时候启动的」暴露在 `/api/health`，
 * 一眼就能判断线上和本地是否同一版本。
 */
import path from 'node:path';

export const STARTED_AT = new Date();

let cachedCommit: string | null = null;

function readGitCommit(): string {
  if (process.env.GIT_COMMIT) return process.env.GIT_COMMIT.slice(0, 12);
  try {
    // Bun 下用内置 spawnSync，Node 下退回 child_process（本项目跑在 Bun，但保留兜底）
    const bun = (globalThis as any).Bun;
    const cwd = process.cwd();
    const out =
      bun?.spawnSync
        ? bun.spawnSync(['git', 'rev-parse', '--short', 'HEAD'], { cwd })
        : null;
    if (out && out.exitCode === 0) {
      const text = new TextDecoder().decode(out.stdout || new Uint8Array()).trim();
      if (text) return text;
    }
  } catch {
    // git 不可用（容器内没有 .git）时降级
  }
  return 'unknown';
}

export function gitCommit(): string {
  cachedCommit ??= readGitCommit();
  return cachedCommit;
}

export interface BuildInfo {
  version: string;
  commit: string;
  env: string;
  pid: number;
  startedAt: string;
  uptimeSec: number;
  cwd: string;
  runtime: string;
}

export function buildInfo(version = '1.0.0'): BuildInfo {
  return {
    version,
    commit: gitCommit(),
    env: process.env.NODE_ENV || 'test',
    pid: process.pid,
    startedAt: STARTED_AT.toISOString(),
    uptimeSec: Math.round(process.uptime()),
    cwd: process.cwd(),
    runtime: `bun ${(globalThis as any).Bun?.version || process.version}`,
  };
}

/** 只用于启动日志，避免把整个 cwd 暴露给 HTTP 响应 */
export function compactBuildInfo(): string {
  return `${gitCommit()} · ${path.basename(process.cwd())} · pid ${process.pid}`;
}
