/**
 * lobby 多 HTML 产物的 SPA 回退：路径解析纯函数单测
 */
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { resolveLobbyEntry } from '../src/utils/lobbyFallback';

const PUBLIC_ENTRY = 'public/lobby/index.html';
const gameEntry = (slug: string) => `public/lobby/game/${slug}/index.html`;
const SLUGS = ['snake', 'gomoku', 'xiangqi', 'othello', 'chess', '2048', 'tetris'];

describe('resolveLobbyEntry · 公共入口', () => {
  const paths = [
    '/lobby/',
    '/lobby/login',
    '/lobby/me',
    '/lobby/user/123',
  ];

  for (const pathname of paths) {
    test(`${pathname} → public/lobby/index.html`, () => {
      expect(resolveLobbyEntry(pathname)).toBe(PUBLIC_ENTRY);
    });
  }
});

describe('resolveLobbyEntry · 游戏入口', () => {
  // /lobby/game/<slug>/ 及其 SPA 子路由都回退到同一份游戏 index.html
  const subPaths = [
    '/lobby/game/{slug}/',
    '/lobby/game/{slug}/room/room-1',
    '/lobby/game/{slug}/friends',
    '/lobby/game/{slug}/skins',
    '/lobby/game/{slug}/player/player-1',
  ];

  for (const slug of SLUGS) {
    for (const template of subPaths) {
      const pathname = template.replace('{slug}', slug);
      test(`${pathname} → public/lobby/game/${slug}/index.html`, () => {
        expect(resolveLobbyEntry(pathname)).toBe(gameEntry(slug));
      });
    }
  }
});

describe('resolveLobbyEntry · 兜底与健壮性', () => {
  test('未知 slug 返回 null（交回 Express 后续路由）', () => {
    expect(resolveLobbyEntry('/lobby/game/unknown/room/1')).toBeNull();
    expect(resolveLobbyEntry('/lobby/game/../etc/passwd')).toBeNull();
  });

  test('非 lobby 路径返回 null', () => {
    expect(resolveLobbyEntry('/api/games')).toBeNull();
    expect(resolveLobbyEntry('/admin/overview')).toBeNull();
    expect(resolveLobbyEntry('/')).toBeNull();
  });

  test('带 query、重复尾斜杠也能解析', () => {
    expect(resolveLobbyEntry('/lobby/me/?from=game')).toBe(PUBLIC_ENTRY);
    expect(resolveLobbyEntry('/lobby/game/snake/room/r1/?tab=chat')).toBe(gameEntry('snake'));
  });

  test('空值不抛错', () => {
    expect(resolveLobbyEntry('')).toBeNull();
  });
});

describe('Express 回退路由登记', () => {
  test('必须覆盖不带尾斜杠的游戏首页 URL', () => {
    // gameUrl(slug) 生成 /lobby/game/<slug>，若只登记 '/lobby/game/:slug/*'，
    // 会落到 /lobby/* 回退到公共入口，大厅点游戏会弹回大厅。
    const src = readFileSync(join(import.meta.dir, '..', 'src', 'index.ts'), 'utf8');
    expect(src).toContain("app.get(['/lobby', '/lobby/game/:slug'], lobbySpaFallback)");
    expect(src).toContain("app.get('/lobby/game/:slug/*', lobbySpaFallback)");
  });
});
