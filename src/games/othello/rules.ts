// 黑白棋（Reversi / Othello）规则：纯函数，8×8 棋盘。
// 棋盘坐标 board[row][col]，row/col ∈ [0,7]；格子值为 'black' | 'white' | null。
// 黑方先行。落子必须翻转至少一枚对方棋子；无合法落子方须跳过回合（pass）。
// 双方都无法落子时终局，子数多者胜。

export type OthelloColor = 'black' | 'white';
export type Cell = OthelloColor | null;
export type Board = Cell[][];
export type Pos = [number, number]; // [row, col]

export const SIZE = 8;

const DIRECTIONS: [number, number][] = [
  [-1, -1], [-1, 0], [-1, 1],
  [0, -1], [0, 1],
  [1, -1], [1, 0], [1, 1],
];

export function opponent(color: OthelloColor): OthelloColor {
  return color === 'black' ? 'white' : 'black';
}

export function createInitialBoard(): Board {
  const board: Board = Array.from({ length: SIZE }, () => Array<Cell>(SIZE).fill(null));
  // 中央四子交叉摆放：黑在 (3,4)(4,3)，白在 (3,3)(4,4)
  board[3][3] = 'white';
  board[3][4] = 'black';
  board[4][3] = 'black';
  board[4][4] = 'white';
  return board;
}

/** 在 (row,col) 落 color 子会翻转的对方棋子坐标；不合法返回空数组。 */
export function flipsFor(board: Board, row: number, col: number, color: OthelloColor): Pos[] {
  if (row < 0 || row >= SIZE || col < 0 || col >= SIZE) return [];
  if (board[row][col] !== null) return [];
  const foe = opponent(color);
  const flips: Pos[] = [];
  for (const [dr, dc] of DIRECTIONS) {
    const line: Pos[] = [];
    let r = row + dr;
    let c = col + dc;
    while (r >= 0 && r < SIZE && c >= 0 && c < SIZE && board[r][c] === foe) {
      line.push([r, c]);
      r += dr;
      c += dc;
    }
    // 直线另一端必须是自己的子，中间夹的对方子才会被翻转
    if (line.length > 0 && r >= 0 && r < SIZE && c >= 0 && c < SIZE && board[r][c] === color) {
      flips.push(...line);
    }
  }
  return flips;
}

/** 某方是否存在任意合法落子 */
export function hasLegalMove(board: Board, color: OthelloColor): boolean {
  for (let r = 0; r < SIZE; r++) {
    for (let c = 0; c < SIZE; c++) {
      if (flipsFor(board, r, c, color).length > 0) return true;
    }
  }
  return false;
}

/** 列出某方所有合法落子（供 AI 与前端提示） */
export function legalMoves(board: Board, color: OthelloColor): { pos: Pos; flips: Pos[] }[] {
  const moves: { pos: Pos; flips: Pos[] }[] = [];
  for (let r = 0; r < SIZE; r++) {
    for (let c = 0; c < SIZE; c++) {
      const flips = flipsFor(board, r, c, color);
      if (flips.length > 0) moves.push({ pos: [r, c], flips });
    }
  }
  return moves;
}

/** 就地落子并翻转，返回是否成功 */
export function applyMove(board: Board, row: number, col: number, color: OthelloColor, flips?: Pos[]): boolean {
  const actual = flips ?? flipsFor(board, row, col, color);
  if (actual.length === 0) return false;
  board[row][col] = color;
  for (const [r, c] of actual) board[r][c] = color;
  return true;
}

export function countDiscs(board: Board): { black: number; white: number; empty: number } {
  let black = 0;
  let white = 0;
  let empty = 0;
  for (let r = 0; r < SIZE; r++) {
    for (let c = 0; c < SIZE; c++) {
      if (board[r][c] === 'black') black++;
      else if (board[r][c] === 'white') white++;
      else empty++;
    }
  }
  return { black, white, empty };
}

/** 终局判定：双方均无合法落子 */
export function isGameOver(board: Board): boolean {
  return !hasLegalMove(board, 'black') && !hasLegalMove(board, 'white');
}
