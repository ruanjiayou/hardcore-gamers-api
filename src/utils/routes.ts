/**
 * 路由登记与 404 自诊断（`server/src/utils/routes.ts`）
 *
 * 动机：`/api/admin/login` 线上返回 404，但没人知道是「路径写错」「方法不对」
 * 还是「部署的代码根本没有这个路由」。三者表现完全一样。
 *
 * 做法：所有 router 都通过 `mountRoute()` 挂载（而不是直接 `app.use`），登记表和真实挂载
 * 永远一致；`diagnose()` 把 404 现场翻译成一句人话，`listRoutes()` 给 `/api/health` 用。
 */
import type { Application } from 'express';

interface Mount {
  prefix: string;
  router: any;
  name: string;
}

interface FlatRoute {
  method: string;
  path: string;
  pattern: RegExp;
  name: string;
}

const mounts: Mount[] = [];

const joinPath = (prefix: string, sub: string): string => {
  const p = (prefix || '').replace(/\/+$/, '');
  const s = (sub || '').replace(/^\/+/, '');
  if (!p) return `/${s}`;
  return s ? `${p}/${s}` : p;
};

/** `/rooms/:id` → `^\/rooms\/[^/]+\/?$`（先把正则元字符转义，再放回参数占位） */
const toPattern = (p: string): RegExp => {
  const escaped = p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\/:[^/]+/g, '/[^/]+');
  return new RegExp(`^${escaped}/?$`);
};

function collect(prefix: string, router: any, name: string, out: FlatRoute[]): void {
  const stack = router?.stack;
  if (!Array.isArray(stack)) return;
  for (const layer of stack) {
    if (layer.route) {
      const routePath = String(layer.route.path ?? '');
      const methods = Object.keys(layer.route.methods || {}).filter(m => m !== '_all');
      for (const m of methods) {
        const full = joinPath(prefix, routePath);
        out.push({ method: m.toUpperCase(), path: full, pattern: toPattern(full), name });
      }
    } else if (layer.name === 'router' && layer.handle?.stack) {
      // 嵌套 router：express 不保留原始挂载路径，只能按同前缀继续收集（本项目未使用嵌套）
      collect(prefix, layer.handle, name, out);
    }
  }
}

function flatRoutes(): FlatRoute[] {
  const out: FlatRoute[] = [];
  for (const m of mounts) collect(m.prefix, m.router, m.name, out);
  return out;
}

/** 挂载 router 并登记，顺序与 `app.use` 完全一致 */
export function mountRoute(app: Application, prefix: string, router: any, name: string): void {
  app.use(prefix, router);
  mounts.push({ prefix, router, name });
}

/** 已登记的全部路由，形如 `POST /api/admin/login` */
export function listRoutes(): string[] {
  return flatRoutes()
    .map(r => `${r.method} ${r.path}`)
    .sort((a, b) => a.localeCompare(b));
}

/** 已挂载的前缀，形如 `['/api/games', ...]` */
export function listMounts(): { prefix: string; name: string; count: number }[] {
  const all = flatRoutes();
  return mounts.map(m => ({
    prefix: m.prefix,
    name: m.name,
    count: all.filter(r => r.path === m.prefix || r.path.startsWith(`${m.prefix}/`)).length,
  }));
}

/**
 * 清空登记表。**仅供测试**：`bun test` 多个文件共享同一进程的模块状态，
 * 不清空的话前一个文件挂载的路由会污染后一个文件的 404 断言。
 */
export function resetRoutes(): void {
  mounts.length = 0;
}

/**
 * 把「未匹配的请求」翻译成可执行结论。
 * 返回值会同时写进日志和 404 响应体（`hint` 字段），无需登服务器就能定位。
 */
export function diagnose(method: string, rawUrl: string): string {
  const reqPath = String(rawUrl || '/').split('?')[0].replace(/\/+$/, '') || '/';
  const upper = String(method || 'GET').toUpperCase();
  const all = flatRoutes();

  // 1) 同路径、同方法的路由确实登记了，却依然 404 → 登记表与实际挂载不一致
  const byPath = all.filter(r => r.pattern.test(reqPath));
  const sameMethod = byPath.find(r => r.method === upper);
  if (sameMethod) {
    return (
      `路由已登记为 ${sameMethod.method} ${sameMethod.path}，但请求仍然 404 —— ` +
      `登记表与实际挂载不一致（有 router 绕过 mountRoute 直接 app.use？）`
    );
  }
  // 2) 路径对得上、方法不对
  if (byPath.length) {
    const allow = [...new Set(byPath.map(r => r.method))].join('/');
    return `路径已注册，但方法不匹配：该路径支持 ${allow}，实际 ${upper}`;
  }

  // 3) 前缀挂载了，子路径不存在 → 列出该 router 真实拥有的路由
  const owner = mounts
    .filter(m => reqPath === m.prefix || reqPath.startsWith(`${m.prefix}/`))
    .sort((a, b) => b.prefix.length - a.prefix.length)[0];
  if (owner) {
    const sub = reqPath.slice(owner.prefix.length) || '/';
    const own = all
      .filter(r => r.name === owner.name)
      .map(r => `${r.method} ${r.path.replace(owner.prefix, '') || '/'}`);
    return (
      `前缀 ${owner.prefix}（${owner.name}）已挂载，但其中没有 ${sub}。` +
      `该 router 现有：${own.length ? own.join('、') : '（空）'}`
    );
  }

  // 4) 前缀都没挂载：几乎必然是部署的代码版本不含该路由
  const guess = reqPath.split('/').slice(0, 3).join('/') || reqPath;
  const samePrefix = all.filter(r => r.path.startsWith(guess)).length;
  if (samePrefix) {
    return `前缀 ${guess} 下有 ${samePrefix} 条路由，但没有匹配 ${reqPath} 的；对照 GET /api/health 的 routes 列表`;
  }
  return `未挂载 ${guess} 前缀 —— 当前进程里没有这个路由，基本可以判定部署的代码版本过旧（对照 GET /api/health 的 commit 字段）`;
}
