import { describe, expect, test } from 'bun:test';
import { EMPTY_PLAYER_STATS, normalizeStats, winRate } from '../src/utils/stats';

/**
 * stats 字段统一（SB-042）：新数据写 {matches,winners,draws,flees}，
 * 旧数据里存在 games/winnings 两个旧名，读取时必须归一，否则老玩家战绩会凭空清零。
 */
describe('玩家统计归一', () => {
  test('新字段原样读取', () => {
    expect(normalizeStats({ matches: 10, winners: 6, draws: 1, flees: 2 }))
      .toEqual({ matches: 10, winners: 6, draws: 1, flees: 2 });
  });

  test('旧字段 games/winnings 映射到 matches/winners', () => {
    expect(normalizeStats({ games: 8, winnings: 3, win_rate: 37 }))
      .toEqual({ matches: 8, winners: 3, draws: 0, flees: 0 });
  });

  test('两套字段并存时优先新字段', () => {
    expect(normalizeStats({ games: 1, matches: 5, winnings: 1, winners: 4 }))
      .toEqual({ matches: 5, winners: 4, draws: 0, flees: 0 });
  });

  test('缺失/脏数据不产生 NaN', () => {
    expect(normalizeStats(null)).toEqual(EMPTY_PLAYER_STATS);
    expect(normalizeStats({ matches: 'abc' })).toEqual(EMPTY_PLAYER_STATS);
  });

  test('胜率按 0~100 取整，无对局时为 0', () => {
    expect(winRate({ matches: 0, winners: 0, draws: 0, flees: 0 })).toBe(0);
    expect(winRate({ matches: 3, winners: 2, draws: 0, flees: 0 })).toBe(67);
  });
});
