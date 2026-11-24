import type { PlayerStats } from '../types';

/**
 * 玩家统计的唯一字段口径：{ matches, winners, draws, flees }。
 *
 * 历史数据里同时存在 `games`（对局数）和 `winnings`（胜场）两个旧名，
 * 结算只写 `winners` 导致 `winnings` 永远为 0（见 03-data-model §2.6）。
 * 新数据一律写统一字段；读旧数据时用 normalizeStats 归一，不用改库。
 */
export const EMPTY_PLAYER_STATS: PlayerStats = { matches: 0, winners: 0, draws: 0, flees: 0 };

export function normalizeStats(raw: any): PlayerStats {
  const num = (v: any) => (Number.isFinite(Number(v)) ? Number(v) : 0);
  return {
    matches: num(raw?.matches ?? raw?.games),
    winners: num(raw?.winners ?? raw?.winnings),
    draws: num(raw?.draws),
    flees: num(raw?.flees),
  };
}

/** 胜率（0~100 整数），无对局时为 0 */
export function winRate(stats: PlayerStats): number {
  return stats.matches > 0 ? Math.round((stats.winners / stats.matches) * 100) : 0;
}
