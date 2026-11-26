/**
 * 排行榜缓存（`SB-062`）：按 `game_id + board` 缓存一份 Top100，调用方按 limit 本地 slice。
 *
 * 为什么不按 limit 分 key：不同页面（主页 Top5 / 弹框 Top10）会生成一堆重复数据，
 * 缓存一份 Top100 足够覆盖所有展示场景，失效也只要删一个 key。
 * 60s TTL 只是兜底漏失效的路径，正常写分靠主动 del。
 */
import config from '../config';

export interface CacheRedis {
  get(key: string): Promise<string | null>;
  set(key: string, value: string, seconds: number): Promise<any>;
  del(...keys: string[]): Promise<any>;
}

export const BOARD_TTL = 60;
export const BOARD_SIZE = 100;
const P = () => config.prefix || '';
export const boardKey = (game_id: string, board?: string) => `${P()}board:${game_id}:${board || 'all'}`;

export class LeaderboardCache {
  constructor(private redis: CacheRedis) {}

  async get(game_id: string, board?: string): Promise<any[] | null> {
    const raw = await this.redis.get(boardKey(game_id, board));
    if (raw === null || raw === undefined || raw === '') return null;
    try {
      const rows = JSON.parse(raw);
      return Array.isArray(rows) ? rows : null;
    } catch {
      return null; // 脏缓存当未命中，下次查询会覆盖
    }
  }

  async set(game_id: string, board: string | undefined, rows: any[]): Promise<void> {
    await this.redis.set(boardKey(game_id, board), JSON.stringify(rows.slice(0, BOARD_SIZE)), BOARD_TTL);
  }

  /** 写分后删具体分榜 + 总榜（同一玩家的 score 也变了） */
  async invalidate(game_id: string, board?: string): Promise<void> {
    await this.redis.del(boardKey(game_id, board), boardKey(game_id));
  }
}
