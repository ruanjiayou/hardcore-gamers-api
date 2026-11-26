/**
 * lobby 多 HTML 产物的 SPA 回退路径解析（纯函数，便于单测）。
 *
 * 生产构建产物：public/lobby/index.html（公共入口）
 *                public/lobby/game/<slug>/index.html（7 个游戏入口）
 * 这里只按 URL 解析出待 sendFile 的相对路径；非 lobby 路径或未知 slug 返回 null，
 * 让 Express 继续走后续路由。slug 必须命中白名单，避免把 URL 片段拼进文件路径。
 */

const LOBBY_GAME_SLUGS = ['snake', 'gomoku', 'xiangqi', 'othello', 'chess', '2048', 'tetris'] as const;
const SLUG_SET: ReadonlySet<string> = new Set<string>(LOBBY_GAME_SLUGS);

export function resolveLobbyEntry(pathname: string): string | null {
  // 调用方一般传 req.path（已去掉 query）；这里再兜一层，方便直接传 originalUrl
  const pathnameOnly = (pathname || '').split('?')[0].replace(/\/+$/, '');

  const game = /^\/lobby\/game\/([^/]+)(?:\/.*)?$/.exec(pathnameOnly);
  if (game) {
    const slug = game[1];
    return SLUG_SET.has(slug) ? `public/lobby/game/${slug}/index.html` : null;
  }

  if (pathnameOnly === '/lobby' || pathnameOnly.startsWith('/lobby/')) {
    return 'public/lobby/index.html';
  }

  return null;
}
