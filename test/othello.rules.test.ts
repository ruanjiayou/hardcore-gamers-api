import { describe, expect, test } from 'bun:test';
import {
  createInitialBoard, flipsFor, applyMove, legalMoves, hasLegalMove,
  isGameOver, countDiscs, opponent, Board,
} from '../src/games/othello/rules';

describe('服务端黑白棋规则', () => {
  test('初始棋盘中央四子交叉', () => {
    const b = createInitialBoard();
    const c = countDiscs(b);
    expect(c.black).toBe(2);
    expect(c.white).toBe(2);
    expect(c.empty).toBe(60);
    expect(b[3][3]).toBe('white');
    expect(b[3][4]).toBe('black');
  });

  test('初始黑方有 4 个合法落子点', () => {
    const b = createInitialBoard();
    expect(legalMoves(b, 'black').length).toBe(4);
    expect(legalMoves(b, 'white').length).toBe(4);
  });

  test('落子翻转正确方向的棋子', () => {
    const b: Board = Array.from({ length: 8 }, () => new Array(8).fill(null));
    // 横向：白 白 空，黑在更远处 → 黑落空位翻转两枚白
    b[3][1] = 'black';
    b[3][2] = 'white';
    b[3][3] = 'white';
    const flips = flipsFor(b, 3, 4, 'black');
    expect(flips.length).toBe(2);
    expect(flips).toContainEqual([3, 2]);
    expect(flips).toContainEqual([3, 3]);
    expect(applyMove(b, 3, 4, 'black', flips)).toBe(true);
    expect(b[3][2]).toBe('black');
    expect(b[3][3]).toBe('black');
    expect(b[3][4]).toBe('black');
  });

  test('无夹击的落子非法', () => {
    const b: Board = Array.from({ length: 8 }, () => new Array(8).fill(null));
    b[3][3] = 'black';
    expect(flipsFor(b, 0, 0, 'black').length).toBe(0);
    expect(applyMove(b, 0, 0, 'black')).toBe(false);
    expect(b[0][0]).toBeNull();
  });

  test('占据的格子不能落子', () => {
    const b = createInitialBoard();
    expect(flipsFor(b, 3, 3, 'black').length).toBe(0);
  });

  test('opponent 正确', () => {
    expect(opponent('black')).toBe('white');
    expect(opponent('white')).toBe('black');
  });

  test('棋盘填满时终局', () => {
    const b: Board = Array.from({ length: 8 }, () =>
      new Array(8).fill(null).map((_, c) => (c % 2 === 0 ? 'black' : 'white')),
    );
    expect(hasLegalMove(b, 'black')).toBe(false);
    expect(hasLegalMove(b, 'white')).toBe(false);
    expect(isGameOver(b)).toBe(true);
  });

  test('有空位但某方无棋时该方 hasLegalMove 为 false', () => {
    // 全黑棋盘 + 一个空格，白方无子 → 白方无处夹击
    const b: Board = Array.from({ length: 8 }, () => new Array(8).fill('black'));
    b[0][0] = null;
    expect(hasLegalMove(b, 'white')).toBe(false);
    expect(hasLegalMove(b, 'black')).toBe(false); // 黑落 (0,0) 无法翻转白（无白子）
  });
});
