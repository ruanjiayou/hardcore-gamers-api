/**
 * 路由登记与 404 自诊断（独立文件：`mounts` 是模块级状态，与 HTTP 集成测试分开跑才互不污染）
 */
import { beforeAll, describe, test, expect } from 'bun:test';
import { Router } from 'express';
import { diagnose, listMounts, listRoutes, mountRoute, resetRoutes } from '../src/utils/routes';

const fakeApp = { use: () => fakeApp } as any;

beforeAll(() => {
  // bun test 多文件共享模块状态：先清空，保证本文件的断言只看到自己挂的路由
  resetRoutes();
  const adminRouter = Router();
  adminRouter.post('/login', (_req, res) => res.end());
  adminRouter.get('/overview', (_req, res) => res.end());
  mountRoute(fakeApp, '/api/admin', adminRouter, 'admin');

  const gameRouter = Router();
  gameRouter.get('/', (_req, res) => res.end());
  mountRoute(fakeApp, '/api/games', gameRouter, 'game');
});

describe('routes · 登记', () => {
  test('登记的路由按 `METHOD /path` 列出', () => {
    const routes = listRoutes();
    expect(routes).toContain('POST /api/admin/login');
    expect(routes).toContain('GET /api/admin/overview');
    expect(routes).toContain('GET /api/games');
  });

  test('mounts 摘要含前缀、名称与路由数', () => {
    const admin = listMounts().find(m => m.prefix === '/api/admin');
    expect(admin).toEqual({ prefix: '/api/admin', name: 'admin', count: 2 });
  });
});

describe('routes · 404 自诊断', () => {
  test('路径存在但方法不对 → 明确指出应为哪个方法', () => {
    const hint = diagnose('GET', '/api/admin/login');
    expect(hint).toContain('方法不匹配');
    expect(hint).toContain('POST');
  });

  test('前缀已挂载但子路径不存在 → 列出该 router 真实路由', () => {
    const hint = diagnose('POST', '/api/admin/not-exist');
    expect(hint).toContain('前缀 /api/admin（admin）已挂载');
    expect(hint).toContain('POST /login');
  });

  test('前缀完全没挂载 → 指向部署版本过旧', () => {
    const hint = diagnose('GET', '/api/nowhere/x');
    expect(hint).toContain('未挂载 /api/nowhere 前缀');
    expect(hint).toContain('commit');
  });

  test('带 query 与末尾斜杠也能正确判定', () => {
    expect(diagnose('GET', '/api/admin/login/?from=web')).toContain('方法不匹配');
  });

  test('路径参数能被匹配（/:id），且登记后仍 404 会提示登记表不一致', () => {
    const app2 = { use: () => app2 } as any;
    const r = Router();
    r.delete('/rooms/:id', (_req, res) => res.end());
    mountRoute(app2, '/api/room-test', r, 'roomTest');
    expect(diagnose('POST', '/api/room-test/rooms/abc')).toContain('方法不匹配');
    expect(diagnose('DELETE', '/api/room-test/rooms/abc')).toContain('登记表与实际挂载不一致');
  });
});
