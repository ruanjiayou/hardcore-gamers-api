import { describe, test, expect } from 'bun:test';
import { checkScore, lineClearScore, levelFor, gravityMs, MAX_SCORE, LINES_PER_LEVEL } from '../src/games/tetris/rules';

describe('俄罗斯方块计分与校验规则', () => {
  test('checkScore：正常分数通过', () => {
    expect(checkScore(0)).toEqual({ valid: true, score: 0 });
    expect(checkScore(1234).valid).toBe(true);
  });

  test('checkScore：负数/小数/非数字/超上限均拒绝', () => {
    expect(checkScore(-1).valid).toBe(false);
    expect(checkScore(1.5).valid).toBe(false);
    expect(checkScore('100' as any).valid).toBe(false);
    expect(checkScore(NaN).valid).toBe(false);
    expect(checkScore(Infinity).valid).toBe(false);
    expect(checkScore(MAX_SCORE + 1).valid).toBe(false);
  });

  test('levelFor：每 10 行升一级', () => {
    expect(levelFor(0)).toBe(1);
    expect(levelFor(LINES_PER_LEVEL - 1)).toBe(1);
    expect(levelFor(LINES_PER_LEVEL)).toBe(2);
    expect(levelFor(LINES_PER_LEVEL * 5)).toBe(6);
  });

  test('lineClearScore：1/2/3/4 行基础分与等级加成', () => {
    expect(lineClearScore(0, 1)).toBe(0);
    expect(lineClearScore(1, 1)).toBe(100);
    expect(lineClearScore(2, 1)).toBe(300);
    expect(lineClearScore(3, 1)).toBe(500);
    expect(lineClearScore(4, 1)).toBe(800);
    // 等级加成：4 行在 5 级 = 800 * 5
    expect(lineClearScore(4, 5)).toBe(4000);
    // 超过 4 行按 4 行封顶
    expect(lineClearScore(6, 1)).toBe(800);
  });

  test('gravityMs：等级越高越快，最低 60ms', () => {
    expect(gravityMs(1)).toBe(800);
    expect(gravityMs(2)).toBe(730);
    expect(gravityMs(1)).toBeGreaterThan(gravityMs(5));
    expect(gravityMs(99)).toBe(60);
  });
});
