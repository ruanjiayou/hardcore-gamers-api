/**
 * 日志（pino）+ HTTP 访问日志集成
 *
 * 注意：本文件**不调用 mountRoute**，让路由登记表保持为空，
 * 从而复现线上真实场景（部署的进程里确实没有 /api/admin 这条路由）。
 */
import { beforeAll, describe, test, expect } from 'bun:test';
import express from 'express';
import http from 'node:http';
import { createLogger, maskDsn, recentLogs } from '../src/utils/logger';
import { resetRoutes } from '../src/utils/routes';
import { apiNotFound, errorHandler, getHttpStats, requestLogger } from '../src/middleware/requestLogger';

const log = createLogger('test');

beforeAll(() => {
  // 清空路由登记表，复现线上真实场景：进程里确实没有 /api/admin 这条路由
  resetRoutes();
});

describe('logger · pino 能力', () => {
  test('带 scope，且 warn/error 可分级过滤', () => {
    log.info('hello-info');
    log.error('hello-error');
    const all = recentLogs(20) as any[];
    const info = all.find(e => e.msg === 'hello-info');
    expect(info?.level).toBe('info');
    expect(info?.scope).toBe('test');
    expect(all.some(e => e.msg === 'hello-error' && e.level === 'error')).toBe(true);

    const onlyError = recentLogs(10, 'error');
    expect(onlyError.every(e => e.level === 'error')).toBe(true);
    expect(recentLogs(1).length).toBe(1);
  });

  test('低于 LOG_LEVEL 的日志直接丢弃', () => {
    log.debug('hidden-debug');
    expect(recentLogs(50).some(e => (e as any).msg === 'hidden-debug')).toBe(false);
  });

  test('redact 自动给敏感字段打码（不再手写 maskSecrets）', () => {
    log.info({ req: { body: { pass: 'p@ss', password: 'x', nickname: '玩家1' } } }, 'login');
    const entry = recentLogs(10).find(e => (e as any).msg === 'login') as any;
    expect(entry.req.body.pass).toBe('***');
    expect(entry.req.body.password).toBe('***');
    expect(entry.req.body.nickname).toBe('玩家1');
    expect(JSON.stringify(entry)).not.toContain('p@ss');
  });

  test('循环引用与 Error 由 pino 安全序列化', () => {
    const a: any = { name: 'a' };
    a.self = a;
    expect(() => log.info({ a }, 'cyclic')).not.toThrow();
    expect(() => log.error({ err: new Error('boom') }, 'err-log')).not.toThrow();
    const cyclic = recentLogs(10).find(e => (e as any).msg === 'cyclic') as any;
    expect(cyclic.a.self).toBe('[Circular]');
    const errEntry = recentLogs(10).find(e => (e as any).msg === 'err-log') as any;
    expect(errEntry.err.message).toBe('boom');
    expect(errEntry.err.stack).toContain('boom');
  });

  test('DSN 里的密码被打掉（redact 打不到字符串内部）', () => {
    expect(maskDsn('mongodb://root:123456@100.125.39.89:27017/games')).toBe(
      'mongodb://root:***@100.125.39.89:27017/games',
    );
    expect(maskDsn('redis://:pwd@1.2.3.4:6369')).toBe('redis://:***@1.2.3.4:6369');
    expect(maskDsn('')).toBe('');
  });
});

describe('requestLogger · HTTP 集成（pino-http）', () => {
  const app = express();
  app.use(requestLogger);
  app.use(express.json());
  app.get('/api/games', (_req, res) => res.json({ code: 0, data: [] }));
  app.post('/api/boom', () => {
    throw new Error('boom');
  });
  app.use('/api', apiNotFound);
  app.use(errorHandler);

  let server: http.Server;
  let base = '';

  const start = async () => {
    if (base) return;
    await new Promise<void>(resolve => {
      server = app.listen(0, () => {
        const addr = server.address() as any;
        base = `http://127.0.0.1:${addr.port}`;
        resolve();
      });
    });
  };

  test('正常请求带 X-Request-Id，并计入统计', async () => {
    await start();
    const before = getHttpStats().total;
    const res = await fetch(`${base}/api/games`);
    expect(res.status).toBe(200);
    expect(res.headers.get('x-request-id')).toMatch(/^[0-9a-f]{8}$/);
    expect(getHttpStats().total).toBe(before + 1);
  });

  test('未匹配的 /api 返回 JSON，hint 直接指出「未挂载前缀」', async () => {
    await start();
    const res = await fetch(`${base}/api/admin/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ pass: 'p@ss' }),
    });
    expect(res.status).toBe(404);
    const body: any = await res.json();
    expect(body.code).toBe(404);
    expect(body.message).toContain('接口不存在');
    expect(body.hint).toContain('未挂载 /api/admin 前缀');

    const stats = getHttpStats();
    expect(stats.unmatched.find(u => u.path === 'POST /api/admin/login')?.count).toBeGreaterThan(0);
    expect(stats.byStatus['4xx']).toBeGreaterThan(0);
  });

  test('404 日志带 hint、级别为 warn、密码已打码', () => {
    const entry = recentLogs(50).find(e => (e as any).msg === 'POST /api/admin/login 404') as any;
    expect(entry).toBeTruthy();
    expect(entry.level).toBe('warn');
    expect(entry.hint).toContain('未挂载 /api/admin 前缀');
    expect(entry.req.body.pass).toBe('***');
    expect(JSON.stringify(entry)).not.toContain('p@ss');
  });

  test('handler 抛错 → 500 JSON 带 requestId，真实堆栈进日志', async () => {
    await start();
    const res = await fetch(`${base}/api/boom`, { method: 'POST' });
    expect(res.status).toBe(500);
    const body: any = await res.json();
    expect(body.code).toBe(500);
    expect(body.requestId).toMatch(/^[0-9a-f]{8}$/);
    const entry = recentLogs(20).find(e => (e as any).msg === 'POST /api/boom 500') as any;
    expect(entry.level).toBe('error');
    expect(entry.err.stack).toContain('boom'); // errorHandler 挂到 res.err 上的真实错误
  });
});
