/**
 * 诊断接口（`/api/debug/*`，`server/src/controller/diagnostics.ts`）
 *
 * 线上出问题时没有 SSH 也能定位：
 * - `GET /api/debug/routes`  当前进程真实注册了哪些路由（含 commit）
 * - `GET /api/debug/logs`    最近 N 条日志（需要 admin_pass 换取，默认关闭）
 * - `GET /api/debug/config`  脱敏后的生效配置（能看出 admin_pass 配没配）
 *
 * 这三个接口**只读**，不提供任何写操作。
 */
import { Router } from 'express';
import crypto from 'node:crypto';
import config from '../config';
import { buildInfo, STARTED_AT } from '../utils/buildInfo';
import { listMounts, listRoutes } from '../utils/routes';
import { recentLogs, maskDsn, type LogLevel } from '../utils/logger';
import { getHttpStats } from '../middleware/requestLogger';

const router = Router();

/** 定长哈希比较，避免密码长度/前缀泄露 */
const same = (a: string, b: string) =>
  crypto.timingSafeEqual(
    crypto.createHash('sha256').update(a).digest(),
    crypto.createHash('sha256').update(b).digest(),
  );

const adminPass = () => config.admin_pass || process.env.ADMIN_PASS || '';

/** 日志/配置里可能带 IP、昵称、DSN，必须凭 admin_pass 才能看 */
function guard(req: any, res: any): boolean {
  const pass = adminPass();
  if (!pass) {
    res.status(403).json({
      code: 403,
      message: '未配置 admin_pass，诊断端点默认关闭',
      hint: '在 etcd 的 games-api 里加 "admin_pass" 后即可用 x-log-token 访问',
    });
    return false;
  }
  const token = String(req.headers['x-log-token'] || req.query.token || '');
  if (!token || !same(token, pass)) {
    res.status(401).json({ code: 401, message: '需要正确的 admin_pass（header: x-log-token）' });
    return false;
  }
  return true;
}

router.get('/routes', (_req, res) => {
  const routes = listRoutes();
  res.json({
    code: 0,
    data: {
      ...buildInfo(),
      uptimeText: `${Math.round((Date.now() - STARTED_AT.getTime()) / 1000)}s`,
      mounts: listMounts(),
      routeCount: routes.length,
      routes,
      http: getHttpStats(),
    },
  });
});

router.get('/logs', (req, res) => {
  if (!guard(req, res)) return;
  const limit = Math.min(Math.max(Number(req.query.limit) || 100, 1), 300);
  const level = String(req.query.level || '') as LogLevel;
  const valid = ['debug', 'info', 'warn', 'error'];
  const logs = recentLogs(limit, valid.includes(level) ? level : undefined);
  res.json({ code: 0, data: { level: level || 'all', count: logs.length, logs } });
});

router.get('/config', (req, res) => {
  if (!guard(req, res)) return;
  res.json({
    code: 0,
    data: {
      port: config.port,
      env: process.env.NODE_ENV || 'test',
      prefix: config.prefix,
      mongo_url: maskDsn(config.mongo_url),
      redis_url: maskDsn(config.redis_url),
      robot_url: config.robot_url,
      server_ws_url: config.server_ws_url,
      secret: config.secret ? '***(已配置)' : '',
      admin_pass: config.admin_pass ? '***(已配置)' : '',
      voice_pack_allowlist: config.voice_pack_allowlist?.length || 0,
      enabled: config.enabled,
      max_robot_per_room: config.max_robot_per_room,
      logLevel: process.env.LOG_LEVEL || 'info',
    },
  });
});

export default router;
