import { describe, expect, test, spyOn, afterEach } from 'bun:test';
import Othello from '../src/games/othello/index';
import { MMatch } from '../src/models';
import { hasLegalMove, opponent, type Board, type Cell, type OthelloColor } from '../src/games/othello/rules';

/** 解析 'B/W/.' 局面串 */
function boardOf(s: string): Board {
  return s.split('/').map(row =>
    [...row].map((ch): Cell => ch === 'B' ? 'black' : ch === 'W' ? 'white' : null),
  );
}
const key = (b: Board) => b.map(r => r.map(c => c === 'black' ? 'B' : c === 'white' ? 'W' : '.').join('')).join('/');

/** 黑无棋、白有棋的真实局面（随机对局中搜得） */
const BLACK_STUCK = 'WBBBBBBW/BBBWBBBB/BBWBWWBB/BBBBWWBB/WBBBBBBB/W.BWWWB./WWWBWWB./WWWWWWB.';
/** 全满交替棋盘：双方都无棋 */
const FULL_BOARD = Array.from({ length: 8 }, (_, r) =>
  Array.from({ length: 8 }, (_, c): Cell => ((r + c) % 2 === 0 ? 'black' : 'white')),
);

const players = [
  { _id: 'p-black', role: 'black', score: 0, is_winner: false },
  { _id: 'p-white', role: 'white', score: 0, is_winner: false },
];

afterEach(() => { /* spyOn 的 mock 在 bun 中每次测试后由 mockRestore 处理 */ });

describe('服务端黑白棋对局流程', () => {
  test('测试局面确实黑无棋、白有棋', () => {
    const b = boardOf(BLACK_STUCK);
    expect(hasLegalMove(b, 'black')).toBe(false);
    expect(hasLegalMove(b, 'white')).toBe(true);
  });

  test('decidePassTurn：仅我方无棋 → 回合交给对方，不终局', () => {
    const b = boardOf(BLACK_STUCK);
    expect(Othello.decidePassTurn(b, 'black', players as any)).toEqual({ endGame: false, nextTurn: 'p-white' });
    // 镜像：白方无棋时交给黑方
    const mirrored: Board = b.map(row => row.map(c =>
      c === 'black' ? 'white' : c === 'white' ? 'black' : null,
    ));
    expect(hasLegalMove(mirrored, 'white')).toBe(false);
    expect(Othello.decidePassTurn(mirrored, 'white', players as any)).toEqual({ endGame: false, nextTurn: 'p-black' });
  });

  test('decidePassTurn：双方都无棋 → 终局，nextTurn 为空', () => {
    expect(Othello.decidePassTurn(FULL_BOARD, 'black', players as any)).toEqual({ endGame: true, nextTurn: '' });
  });

  test('excuteMove pass：黑方无棋跳过后 next_turn 是白方（回归卡死 bug）', async () => {
    const spy = spyOn(MMatch, 'updateOne').mockImplementation(async () => ({}) as any);
    try {
      const match: any = {
        _id: 'm1', room_id: 'r1',
        players,
        curr_state: { curr_turn: 'p-black', board: boardOf(BLACK_STUCK), first: 'black' },
      };
      const res = await Othello.excuteMove(match, { player_id: 'p-black', to: [-1, -1] });
      expect(res.success).toBe(true);
      expect(res.gameover).toBe(false);
      expect(res.data?.next_turn).toBe('p-white');
      expect(res.data?.pass).toBe(true);
      expect(spy).toHaveBeenCalled();
    } finally {
      spy.mockRestore();
    }
  });

  test('excuteMove pass：双方无棋 → 终局并按子数判胜', async () => {
    const spy = spyOn(MMatch, 'updateOne').mockImplementation(async () => ({}) as any);
    try {
      const b = FULL_BOARD.map(row => row.slice());
      b[0][1] = 'black'; // (0,1) 原为白，翻黑制造子数差：黑 33 : 白 31
      const match: any = {
        _id: 'm2', room_id: 'r1',
        players,
        curr_state: { curr_turn: 'p-black', board: b, first: 'black' },
      };
      const res = await Othello.excuteMove(match, { player_id: 'p-black', to: [-1, -1] });
      expect(res.success).toBe(true);
      expect(res.gameover).toBe(true);
      expect(res.data?.winner).toBe('p-black');
      expect(res.data?.next_turn).toBe('');
    } finally {
      spy.mockRestore();
    }
  });

  test('excuteMove pass：仍有合法落子时拒绝跳过', async () => {
    const spy = spyOn(MMatch, 'updateOne').mockImplementation(async () => ({}) as any);
    try {
      const match: any = {
        _id: 'm3', room_id: 'r1',
        players,
        curr_state: { curr_turn: 'p-black', board: [[null]] as any, first: 'black' },
      };
      // 用初始盘（黑有合法落子）
      const { createInitialBoard } = await import('../src/games/othello/rules');
      match.curr_state.board = createInitialBoard();
      const res = await Othello.excuteMove(match, { player_id: 'p-black', to: [-1, -1] });
      expect(res.success).toBe(false);
      expect(spy).not.toHaveBeenCalled();
    } finally {
      spy.mockRestore();
    }
  });
});
