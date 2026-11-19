import { describe, test, expect } from 'bun:test';
import { checkScore, MAX_SCORE } from '../src/games/2048/rules';
import Game2048 from '../src/games/2048';

describe('2048 分数校验', () => {
  test('合法分数：0、正整数、上限值', () => {
    expect(checkScore(0)).toEqual({ valid: true, score: 0 });
    expect(checkScore(2048)).toEqual({ valid: true, score: 2048 });
    expect(checkScore(123456)).toEqual({ valid: true, score: 123456 });
    expect(checkScore(MAX_SCORE)).toEqual({ valid: true, score: MAX_SCORE });
  });

  test('非法分数：负数、小数、NaN、非数字、超上限', () => {
    expect(checkScore(-1).valid).toBe(false);
    expect(checkScore(3.14).valid).toBe(false);
    expect(checkScore(NaN).valid).toBe(false);
    expect(checkScore(Infinity).valid).toBe(false);
    expect(checkScore('2048' as any).valid).toBe(false);
    expect(checkScore(null).valid).toBe(false);
    expect(checkScore(MAX_SCORE + 1).valid).toBe(false);
  });
});

describe('2048 游戏逻辑', () => {
  test('getInitState 返回单人先手状态', () => {
    const s = Game2048.getInitState();
    expect(s.first).toBe('player');
    expect(s.score).toBe(0);
  });

  test('assignRole / assignRoles 固定 player 角色', () => {
    const member: any = { _id: 'p1', role: '' };
    Game2048.assignRole({ members: [] } as any, member);
    expect(member.role).toBe('player');
    const assigned = Game2048.assignRoles([{ _id: 'p1' } as any, { _id: 'p2' } as any]);
    expect(assigned.map(a => a.role)).toEqual(['player', 'player']);
  });
});
