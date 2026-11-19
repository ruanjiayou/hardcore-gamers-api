// 国际象棋规则：纯函数，8×8 棋盘。
// 坐标 board[row][col]，row 0 为黑方底线(第8横线)，row 7 为白方底线(第1横线)。
// col 0..7 对应 a..h。白方先行。
// 支持：王车易位、吃过路兵、兵升变、将军/将死/逼和（逼和判平局）。

export type Color = 'white' | 'black';
export type PieceType = 'k' | 'q' | 'r' | 'b' | 'n' | 'p';
export interface Piece { type: PieceType; color: Color }
export type Cell = Piece | null;
export type Board = Cell[][];
export type Pos = [number, number]; // [row, col]

export const SIZE = 8;

export function opponent(c: Color): Color { return c === 'white' ? 'black' : 'white'; }
function inside(r: number, c: number) { return r >= 0 && r < SIZE && c >= 0 && c < SIZE; }
function same(p: Cell, color: Color) { return !!p && p.color === color; }

export function createInitialBoard(): Board {
  const back: PieceType[] = ['r', 'n', 'b', 'q', 'k', 'b', 'n', 'r'];
  const b: Board = Array.from({ length: SIZE }, () => Array<Cell>(SIZE).fill(null));
  for (let c = 0; c < SIZE; c++) {
    b[0][c] = { type: back[c], color: 'black' };
    b[1][c] = { type: 'p', color: 'black' };
    b[6][c] = { type: 'p', color: 'white' };
    b[7][c] = { type: back[c], color: 'white' };
  }
  return b;
}

export interface GameState {
  board: Board;
  curr_turn: string;
  first: 'white';
  // 易位权：王和车的初始位置是否仍未移动
  castling: { whiteK: boolean; whiteQ: boolean; blackK: boolean; blackQ: boolean };
  enPassant: Pos | null;   // 可被吃过路兵的格子
  halfmove: number;        // 50 步规则计数
}

export function createInitialState(): Omit<GameState, 'curr_turn'> {
  return {
    board: createInitialBoard(),
    first: 'white',
    castling: { whiteK: true, whiteQ: true, blackK: true, blackQ: true },
    enPassant: null,
    halfmove: 0,
  };
}

/** 找王坐标 */
function findKing(board: Board, color: Color): Pos | null {
  for (let r = 0; r < SIZE; r++) {
    for (let c = 0; c < SIZE; c++) {
      const p = board[r][c];
      if (p?.type === 'k' && p.color === color) return [r, c];
    }
  }
  return null;
}

/** 判断格子 (r,c) 是否被 color 方攻击（不含王车易位中经过格的特殊处理） */
export function isAttacked(board: Board, r: number, c: number, by: Color): boolean {
  // 兵攻击：白兵向上(r-1)攻击，黑兵向下(r+1)攻击
  const pawnRow = by === 'white' ? r + 1 : r - 1;
  for (const dc of [-1, 1]) {
    if (inside(pawnRow, c + dc)) {
      const p = board[pawnRow][c + dc];
      if (p?.type === 'p' && p.color === by) return true;
    }
  }
  // 马
  const knightDeltas: [number, number][] = [
    [-2,-1],[-2,1],[-1,-2],[-1,2],[1,-2],[1,2],[2,-1],[2,1],
  ];
  for (const [dr, dc] of knightDeltas) {
    const rr = r + dr, cc = c + dc;
    if (inside(rr, cc)) {
      const p = board[rr][cc];
      if (p?.type === 'n' && p.color === by) return true;
    }
  }
  // 王
  for (const dr of [-1, 0, 1]) for (const dc of [-1, 0, 1]) {
    if (dr === 0 && dc === 0) continue;
    const rr = r + dr, cc = c + dc;
    if (inside(rr, cc)) {
      const p = board[rr][cc];
      if (p?.type === 'k' && p.color === by) return true;
    }
  }
  // 车/后 直线
  const rookDirs: [number, number][] = [[-1,0],[1,0],[0,-1],[0,1]];
  for (const [dr, dc] of rookDirs) {
    let rr = r + dr, cc = c + dc;
    while (inside(rr, cc)) {
      const p = board[rr][cc];
      if (p) {
        if (p.color === by && (p.type === 'r' || p.type === 'q')) return true;
        break;
      }
      rr += dr; cc += dc;
    }
  }
  // 象/后 斜线
  const bishopDirs: [number, number][] = [[-1,-1],[-1,1],[1,-1],[1,1]];
  for (const [dr, dc] of bishopDirs) {
    let rr = r + dr, cc = c + dc;
    while (inside(rr, cc)) {
      const p = board[rr][cc];
      if (p) {
        if (p.color === by && (p.type === 'b' || p.type === 'q')) return true;
        break;
      }
      rr += dr; cc += dc;
    }
  }
  return false;
}

export function inCheck(board: Board, color: Color): boolean {
  const king = findKing(board, color);
  return king ? isAttacked(board, king[0], king[1], opponent(color)) : false;
}

/** 伪合法走法（易位/吃过路兵由 move 类型标记），不含"走后自身是否被将"校验 */
export interface PseudoMove {
  from: Pos;
  to: Pos;
  promotion?: PieceType;
  castle?: 'K' | 'Q';    // 短/长易位
  enPassant?: boolean;   // 吃过路兵
}

function pseudoMoves(state: GameState, color: Color): PseudoMove[] {
  const board = state.board;
  const moves: PseudoMove[] = [];
  for (let r = 0; r < SIZE; r++) {
    for (let c = 0; c < SIZE; c++) {
      const p = board[r][c];
      if (!same(p, color)) continue;
      const from: Pos = [r, c];
      const type = p!.type;
      if (type === 'p') {
        const dir = color === 'white' ? -1 : 1;
        const startRow = color === 'white' ? 6 : 1;
        const promoRow = color === 'white' ? 0 : 7;
        // 前进一格
        const r1 = r + dir;
        if (inside(r1, c) && !board[r1][c]) {
          if (r1 === promoRow) {
            for (const pr of ['q','r','b','n'] as PieceType[]) moves.push({ from, to: [r1, c], promotion: pr });
          } else {
            moves.push({ from, to: [r1, c] });
            // 前进两格
            const r2 = r + 2 * dir;
            if (r === startRow && !board[r2][c]) moves.push({ from, to: [r2, c] });
          }
        }
        // 斜吃
        for (const dc of [-1, 1]) {
          const rr = r + dir, cc = c + dc;
          if (!inside(rr, cc)) continue;
          const target = board[rr][cc];
          if (target && target.color !== color) {
            if (rr === promoRow) {
              for (const pr of ['q','r','b','n'] as PieceType[]) moves.push({ from, to: [rr, cc], promotion: pr });
            } else moves.push({ from, to: [rr, cc] });
          } else if (state.enPassant && state.enPassant[0] === rr && state.enPassant[1] === cc) {
            moves.push({ from, to: [rr, cc], enPassant: true });
          }
        }
      } else if (type === 'n') {
        for (const [dr, dc] of [[-2,-1],[-2,1],[-1,-2],[-1,2],[1,-2],[1,2],[2,-1],[2,1]]) {
          const rr = r + dr, cc = c + dc;
          if (inside(rr, cc) && !same(board[rr][cc], color)) moves.push({ from, to: [rr, cc] });
        }
      } else if (type === 'k') {
        for (const dr of [-1, 0, 1]) for (const dc of [-1, 0, 1]) {
          if (dr === 0 && dc === 0) continue;
          const rr = r + dr, cc = c + dc;
          if (inside(rr, cc) && !same(board[rr][cc], color)) moves.push({ from, to: [rr, cc] });
        }
        // 王车易位
        const homeRow = color === 'white' ? 7 : 0;
        if (r === homeRow && c === 4 && !inCheck(board, color)) {
          const rights = state.castling;
          // 短易位：f1/g1 空且 f1/g1 不受攻击，h1 是车
          const kRight = color === 'white' ? rights.whiteK : rights.blackK;
          const qRight = color === 'white' ? rights.whiteQ : rights.blackQ;
          if (kRight && !board[homeRow][5] && !board[homeRow][6]
            && !isAttacked(board, homeRow, 5, opponent(color))
            && !isAttacked(board, homeRow, 6, opponent(color))
            && board[homeRow][7]?.type === 'r' && board[homeRow][7]?.color === color) {
            moves.push({ from, to: [homeRow, 6], castle: 'K' });
          }
          if (qRight && !board[homeRow][3] && !board[homeRow][2] && !board[homeRow][1]
            && !isAttacked(board, homeRow, 3, opponent(color))
            && !isAttacked(board, homeRow, 2, opponent(color))
            && board[homeRow][0]?.type === 'r' && board[homeRow][0]?.color === color) {
            moves.push({ from, to: [homeRow, 2], castle: 'Q' });
          }
        }
      } else {
        // 滑行棋子
        let dirs: [number, number][];
        if (type === 'r') dirs = [[-1,0],[1,0],[0,-1],[0,1]];
        else if (type === 'b') dirs = [[-1,-1],[-1,1],[1,-1],[1,1]];
        else dirs = [[-1,0],[1,0],[0,-1],[0,1],[-1,-1],[-1,1],[1,-1],[1,1]]; // q
        for (const [dr, dc] of dirs) {
          let rr = r + dr, cc = c + dc;
          while (inside(rr, cc)) {
            if (same(board[rr][cc], color)) break;
            moves.push({ from, to: [rr, cc] });
            if (board[rr][cc]) break;
            rr += dr; cc += dc;
          }
        }
      }
    }
  }
  return moves;
}

/** 执行一步，返回新 state（不修改入参）。action 为客户端/服务端统一走法描述。 */
export interface Action {
  from: Pos;
  to: Pos;
  promotion?: PieceType;
  castle?: 'K' | 'Q';
  enPassant?: boolean;
}

export function applyAction(state: GameState, action: Action): GameState {
  const next: GameState = {
    board: state.board.map(row => row.slice()),
    curr_turn: state.curr_turn,
    first: state.first,
    castling: { ...state.castling },
    enPassant: null,
    halfmove: state.halfmove,
  };
  const { from, to } = action;
  const piece = next.board[from[0]][from[1]]!;
  const color = piece.color;

  // 吃过路兵：删除被吃兵（在 from 行、to 列）
  if (action.enPassant) {
    next.board[from[0]][to[1]] = null;
  }
  // 易位：同步移动车
  if (action.castle) {
    const row = from[0];
    if (action.castle === 'K') {
      next.board[row][5] = next.board[row][7];
      next.board[row][7] = null;
    } else {
      next.board[row][3] = next.board[row][0];
      next.board[row][0] = null;
    }
  }
  // 升变
  if (action.promotion) {
    next.board[to[0]][to[1]] = { type: action.promotion, color };
  } else {
    next.board[to[0]][to[1]] = piece;
  }
  next.board[from[0]][from[1]] = null;

  // 更新易位权
  if (piece.type === 'k') {
    if (color === 'white') { next.castling.whiteK = false; next.castling.whiteQ = false; }
    else { next.castling.blackK = false; next.castling.blackQ = false; }
  }
  if (from[0] === 7 && from[1] === 0 || to[0] === 7 && to[1] === 0) next.castling.whiteQ = false;
  if (from[0] === 7 && from[1] === 7 || to[0] === 7 && to[1] === 7) next.castling.whiteK = false;
  if (from[0] === 0 && from[1] === 0 || to[0] === 0 && to[1] === 0) next.castling.blackQ = false;
  if (from[0] === 0 && from[1] === 7 || to[0] === 0 && to[1] === 7) next.castling.blackK = false;

  // 设置吃过路兵目标（兵走两格时）
  if (piece.type === 'p' && Math.abs(to[0] - from[0]) === 2) {
    next.enPassant = [(from[0] + to[0]) / 2, from[1]];
  }

  // 50 步规则：兵动或吃子清零
  const captured = !!state.board[to[0]][to[1]] || action.enPassant;
  next.halfmove = (piece.type === 'p' || captured) ? 0 : state.halfmove + 1;
  return next;
}

/** 完整合法走法：伪合法 + 走后自身不能处于被将 */
export function legalMoves(state: GameState, color: Color): PseudoMove[] {
  const result: PseudoMove[] = [];
  for (const m of pseudoMoves(state, color)) {
    const next = applyAction(state, m);
    if (!inCheck(next.board, color)) result.push(m);
  }
  return result;
}

/** 找与指定 action 匹配的合法走法（用 from/to + promotion 匹配） */
export function findLegalMove(state: GameState, color: Color, action: Action): PseudoMove | null {
  for (const m of legalMoves(state, color)) {
    if (m.from[0] === action.from[0] && m.from[1] === action.from[1]
      && m.to[0] === action.to[0] && m.to[1] === action.to[1]) {
      // 升变需匹配具体升变棋子；客户端没指定时默认后
      if (m.promotion && action.promotion && m.promotion !== action.promotion) continue;
      if ((m.promotion === 'q') && !action.promotion) return m; // 默认升后
      return m;
    }
  }
  return null;
}

/** 终局判定：返回 'checkmate' | 'stalemate' | 'fifty' | null */
export function gameStatus(state: GameState, color: Color): 'checkmate' | 'stalemate' | 'fifty' | null {
  if (state.halfmove >= 100) return 'fifty';
  const moves = legalMoves(state, color);
  if (moves.length === 0) {
    return inCheck(state.board, color) ? 'checkmate' : 'stalemate';
  }
  return null;
}
