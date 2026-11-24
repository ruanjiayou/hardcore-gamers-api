/**
 * HTTP 访问日志（`server/src/middleware/requestLogger.ts`）
 *
 * 打日志交给 `pino-http`：请求 id、状态、响应耗时、错误序列化都是它的活。
 * 这里只补 pino 不做的两件事：
 * 1. `customProps`：404 时把 `diagnose()` 的结论塞进日志（「404 都不知为什么」的解药）
 * 2. 内存统计：`/api/health` 要展示总量 / 状态分布 / 近期 404 / 慢请求
 */
import { pinoHttp } from 'pino-http';
import crypto from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';
import { createLogger, logger } from '../utils/logger';
import { diagnose } from '../utils/routes';

const log = createLogger('http');

const SLOW_MS = Number(process.env.LOG_SLOW_MS) || 1000;
const UNMATCHED_MAX = 20;

export interface HttpStatsSnapshot {
  total: number;
  byStatus: Record<string, number>;
  /** 近期 404：method + 归一化路径（数字 / ObjectId 段替换成 :id，避免刷屏） */
  unmatched: { path: string; count: number; lastAt: string; hint: string }[];
  slow: { request: string; ms: number; at: string; status: number }[];
}

const stats = {
  total: 0,
  byStatus: {} as Record<string, number>,
  unmatched: new Map<string, { count: number; lastAt: string; hint: string }>(),
  slow: [] as { request: string; ms: number; at: string; status: number }[],
};

const normalizePath = (p: string): string =>
  p
    .split('?')[0]
    .replace(/\/[0-9a-f]{24}(?=\/|$)/gi, '/:id')
    .replace(/\/\d+(?=\/|$)/g, '/:n')
    .replace(/\/+$/, '') || '/';

/**
 * 必须用 `originalUrl`：express 的 router 会把 `req.url` 裁成挂载点之后的相对路径
 * （`app.use('/api', ...)` 之后 `req.url` 变成 `/admin/login`），日志里会丢前缀。
 */
const urlOf = (req: any): string => req?.raw?.originalUrl || req?.originalUrl || req?.raw?.url || req?.url || '/';

/** 统计挂在自己的 finish 回调上，与 pino-http 的日志互不干扰 */
function trackStats(req: Request, res: Response, next: NextFunction): void {
  const started = performance.now();
  res.on('finish', () => {
    const ms = Math.round(performance.now() - started);
    const status = res.statusCode;
    stats.total += 1;
    const key = `${Math.floor(status / 100)}xx`;
    stats.byStatus[key] = (stats.byStatus[key] || 0) + 1;

    if (status === 404) {
      const url = req.originalUrl || req.url || '/';
      const path = `${req.method} ${normalizePath(url)}`;
      const prev = stats.unmatched.get(path);
      stats.unmatched.set(path, {
        count: (prev?.count || 0) + 1,
        lastAt: new Date().toISOString(),
        hint: diagnose(req.method, url),
      });
      while (stats.unmatched.size > UNMATCHED_MAX) {
        stats.unmatched.delete(stats.unmatched.keys().next().value as string);
      }
    }
    if (ms >= SLOW_MS) {
      stats.slow.push({
        request: `${req.method} ${req.originalUrl || req.url}`,
        ms,
        at: new Date().toISOString(),
        status,
      });
      if (stats.slow.length > 10) stats.slow.shift();
    }
  });
  next();
}

const withHint = (req: any, res: any, extra: Record<string, unknown>) => ({
  ...extra,
  // 404 的结论直接进日志，不必再登服务器翻代码
  ...(res.statusCode === 404 ? { hint: diagnose(req?.method || 'GET', urlOf(req)) } : {}),
});

const httpLogger = pinoHttp({
  logger,
  // 关闭 pino-http 的两条"进入/完成"日志，只留响应结束时那一条；
  // 同时也避免它在请求开始就把 req 快照进 child——那时 body 还没被 express.json() 解析
  quietReqLogger: true,
  quietResLogger: true,
  genReqId(_req, res) {
    const id = crypto.randomBytes(4).toString('hex');
    res.setHeader('X-Request-Id', id);
    return id;
  },
  customLogLevel(req, res, err) {
    if (err || res.statusCode >= 500) return 'error';
    if (res.statusCode >= 400) return 'warn';
    if (urlOf(req).startsWith('/api/health')) return 'debug'; // 探活高频，别刷屏
    return 'info';
  },
  customSuccessMessage(req, res) {
    return `${req.method} ${urlOf(req)} ${res.statusCode}`;
  },
  customErrorMessage(req, res) {
    return `${req.method} ${urlOf(req)} ${res.statusCode}`;
  },
  // 在 finish 时才取 req（含 body）与 hint，避免请求开始时的空快照
  customSuccessObject(req, res, { responseTime }) {
    return withHint(req, res, { req, res, responseTime });
  },
  customErrorObject(req, res, err, { responseTime }) {
    return withHint(req, res, { req, res, err, responseTime });
  },
  serializers: {
    req(req) {
      const raw: any = (req as any).raw || req;
      const h = raw.headers || {};
      const ip = String(
        h['cf-connecting-ip'] || h['x-real-ip'] || h['x-forwarded-for'] || raw.socket?.remoteAddress || '',
      )
        .split(',')[0]
        .trim();
      const body = raw.body;
      return {
        method: raw.method,
        url: urlOf(req),
        ip,
        ua: h['user-agent'],
        // 敏感字段由 logger 的 redact 打码（req.body.pass → ***），这里不做手写脱敏
        ...(body && typeof body === 'object' && Object.keys(body).length ? { body } : {}),
      };
    },
    res(res) {
      return { status: res.statusCode };
    },
  },
});

export function requestLogger(req: Request, res: Response, next: NextFunction): void {
  trackStats(req, res, () => httpLogger(req, res, next));
}

/** 未匹配的 `/api/*` 回 JSON：前端能拿到 message/hint，而不是一坨「页面不存在」 */
export function apiNotFound(req: Request, res: Response): void {
  const path = (req.originalUrl || req.url || '/').split('?')[0];
  res.status(404).json({
    code: 404,
    message: `接口不存在：${req.method} ${path}`,
    hint: diagnose(req.method, path),
  });
}

/** Express 四参错误中间件：必须放在所有路由之后 */
export function errorHandler(err: any, req: Request, res: Response, next: NextFunction): void {
  // 挂到 res 上，pino-http 那条 500 日志就会带真实错误，而不是 "failed with status code 500"
  (res as any).err = err;
  if (res.headersSent) {
    log.error({ err, id: (req as any).id }, '响应已发送后抛错');
    next(err);
    return;
  }
  res.status(500).json({
    code: 500,
    message: '服务异常，请稍后重试',
    hint: process.env.NODE_ENV === 'production' ? undefined : String(err?.message || err),
    requestId: (req as any).id,
  });
}

export function getHttpStats(): HttpStatsSnapshot {
  return {
    total: stats.total,
    byStatus: { ...stats.byStatus },
    unmatched: [...stats.unmatched.entries()].map(([path, v]) => ({ path, ...v })),
    slow: [...stats.slow],
  };
}

export default requestLogger;
