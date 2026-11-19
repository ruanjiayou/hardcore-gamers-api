import { describe, expect, test } from 'bun:test';
import { isLegalMove, hasAnyLegalMove } from '../src/games/xiangqi/rules';
import type { Board } from '../src/games/xiangqi/rules';

function emptyBoard(): Board {
  return Array.from({ length: 10 }, () => new Array(9).fill(null));
}
const P = (type: string, color: 'red' | 'black') => ({ type, color });

describe('服务端象棋走法校验', () => {
  test('车直线移动合法、斜走非法', () => {
    const b = emptyBoard();
    b[9][4] = P('k', 'red'); b[0][3] = P('k', 'black');
    b[5][0] = P('r', 'red');
    expect(isLegalMove(b, [5, 0], [5, 5])).toBe(true);
    expect(isLegalMove(b, [5, 0], [4, 1])).toBe(false);
  });

  test('蹩马腿时马不能跳', () => {
    const b = emptyBoard();
    b[9][4] = P('k', 'red'); b[0][3] = P('k', 'black');
    b[5][4] = P('n', 'red');
    expect(isLegalMove(b, [5, 4], [3, 5])).toBe(true); // 腿在 (4,4) 空
    b[4][4] = P('p', 'red'); // 蹩腿
    expect(isLegalMove(b, [5, 4], [3, 5])).toBe(false);
  });

  test('不能走后让己方将被将（送将）', () => {
    const b = emptyBoard();
    b[9][4] = P('k', 'red'); b[0][4] = P('k', 'black');
    b[5][4] = P('r', 'black'); // 黑车盯着红帅所在列
    // 红帅横走到 (9,3) 避开
    expect(isLegalMove(b, [9, 4], [9, 3])).toBe(true);
  });

  test('将帅对脸非法', () => {
    const b = emptyBoard();
    b[9][4] = P('k', 'red'); b[0][4] = P('k', 'black');
    // 直接对脸局面下任何导致对脸的着法都不合法；此处验证红帅不能坐以待毙仍对脸
    // 放一个红车挡住，红车移开则对脸 -> 非法
    b[5][4] = P('r', 'red');
    expect(isLegalMove(b, [5, 4], [5, 0])).toBe(false); // 移开后两将对脸
  });
});

describe('象棋将死/困毙判定（hasAnyLegalMove）', () => {
  test('初始局面双方都有合法走法', () => {
    const b = emptyBoard();
    b[9][4] = P('k', 'red'); b[0][4] = P('k', 'black');
    b[6][0] = P('p', 'red'); b[3][0] = P('p', 'black');
    expect(hasAnyLegalMove(b, 'red')).toBe(true);
    expect(hasAnyLegalMove(b, 'black')).toBe(true);
  });

  test('黑将被双车将死：无合法走法', () => {
    const b = emptyBoard();
    b[9][3] = P('k', 'red');      // 红帅（与黑将不同列，避免对脸干扰）
    b[0][4] = P('k', 'black');    // 黑将
    b[2][4] = P('r', 'red');      // 红车照将（控制第4列，封住 (1,4) 逃点）
    b[0][0] = P('r', 'red');      // 红车控制第0行，封住 (0,3)/(0,5) 逃点
    // 黑将三个逃点 (0,3)/(0,5) 被行0的红车控制，(1,4) 被列4的红车控制
    expect(hasAnyLegalMove(b, 'black')).toBe(false);
    expect(hasAnyLegalMove(b, 'red')).toBe(true);
  });

  test('存在一个逃点时仍判定有合法走法', () => {
    const b = emptyBoard();
    b[9][3] = P('k', 'red');
    b[0][4] = P('k', 'black');
    b[2][4] = P('r', 'red');      // 只封列4
    // 行0无红车，(0,3)/(0,5) 可逃
    expect(hasAnyLegalMove(b, 'black')).toBe(true);
  });

  test('将/帅被吃后该方无合法走法（无将）', () => {
    const b = emptyBoard();
    b[9][3] = P('k', 'red');
    // 黑方无将
    expect(hasAnyLegalMove(b, 'black')).toBe(false);
  });
});
