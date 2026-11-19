import { describe, expect, test } from 'bun:test';
import {
  createInitialState, legalMoves, gameStatus, inCheck, applyAction, findLegalMove,
  type GameState, type Color, type Board, type PieceType, type Color as C,
} from '../src/games/international-chess/rules';

function blankState(turn = ''): GameState {
  return {
    board: Array.from({ length: 8 }, () => new Array(8).fill(null)),
    curr_turn: turn,
    first: 'white',
    castling: { whiteK: false, whiteQ: false, blackK: false, blackQ: false },
    enPassant: null,
    halfmove: 0,
  };
}
const P = (type: PieceType, color: C) => ({ type, color });

describe('服务端国际象棋规则', () => {
  test('初始局面白方有 20 种走法', () => {
    const s = createInitialState() as GameState;
    expect(legalMoves(s, 'white').length).toBe(20);
  });

  test('初始局面双方均未被将', () => {
    const s = createInitialState() as GameState;
    expect(inCheck(s.board, 'white')).toBe(false);
    expect(inCheck(s.board, 'black')).toBe(false);
  });

  test('傻瓜将死：f3 e5 g4 Qh4#', () => {
    let s = createInitialState() as GameState;
    const play = (fr: number, fc: number, tr: number, tc: number) => {
      const m = findLegalMove(s, s.board[fr][fc]!.color as Color, { from: [fr, fc], to: [tr, tc] });
      expect(m).not.toBeNull();
      s = applyAction(s, m!);
    };
    // 白兵 f2->f3 (r6c5->r5c5)
    play(6, 5, 5, 5);
    // 黑兵 e7->e5 (r1c4->r3c4)
    play(1, 4, 3, 4);
    // 白兵 g2->g4
    play(6, 6, 4, 6);
    // 黑后 d8->h4 (r0c3->r4c7)，经 e7(空)-f6-g5
    play(0, 3, 4, 7);
    // 白方被将死
    expect(inCheck(s.board, 'white')).toBe(true);
    expect(gameStatus(s, 'white')).toBe('checkmate');
  });

  test('逼和局面判 stalemate', () => {
    const s = blankState();
    // 黑王 a8，白王 c6，白后 b6：黑无合法走法但未被将
    s.board[0][0] = P('k', 'black');
    s.board[2][2] = P('k', 'white');
    s.board[2][1] = P('q', 'white');
    expect(inCheck(s.board, 'black')).toBe(false);
    expect(legalMoves(s, 'black').length).toBe(0);
    expect(gameStatus(s, 'black')).toBe('stalemate');
  });

  test('短易位：王 e1->g1，车 h1->f1', () => {
    const s = blankState('white');
    s.board[7][4] = P('k', 'white');
    s.board[7][7] = P('r', 'white');
    s.board[0][4] = P('k', 'black');
    s.castling.whiteK = true;
    const m = findLegalMove(s, 'white', { from: [7, 4], to: [7, 6] });
    expect(m?.castle).toBe('K');
    const next = applyAction(s, m!);
    expect(next.board[7][6]?.type).toBe('k');
    expect(next.board[7][5]?.type).toBe('r');
    expect(next.board[7][7]).toBeNull();
    expect(next.castling.whiteK).toBe(false);
  });

  test('吃过路兵：白兵 e5 吃黑兵 d5 落 d6，删除 d5', () => {
    const s = blankState('white');
    s.board[7][4] = P('k', 'white');
    s.board[0][4] = P('k', 'black');
    s.board[3][4] = P('p', 'white'); // e5
    s.board[3][3] = P('p', 'black'); // d5
    s.enPassant = [2, 3];            // 黑兵刚 d7->d5，可落子格 d6=[2,3]（row 减小为白方前进方向）
    const m = findLegalMove(s, 'white', { from: [3, 4], to: [2, 3], enPassant: true });
    expect(m?.enPassant).toBe(true);
    const next = applyAction(s, m!);
    expect(next.board[2][3]?.type).toBe('p');
    expect(next.board[3][3]).toBeNull();
    expect(next.board[3][4]).toBeNull();
  });

  test('兵升变：白兵到 a8 默认升后', () => {
    const s = blankState('white');
    s.board[7][4] = P('k', 'white');
    s.board[0][7] = P('k', 'black');
    s.board[1][0] = P('p', 'white');
    const m = findLegalMove(s, 'white', { from: [1, 0], to: [0, 0] });
    expect(m?.promotion).toBe('q');
    const next = applyAction(s, m!);
    expect(next.board[0][0]).toEqual(P('q', 'white'));
  });
});
