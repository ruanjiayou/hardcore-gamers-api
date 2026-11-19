/**
 * 服务端象棋走法权威校验
 *
 * 服务端是局面真值来源：任何走法（真人 or 人机）都必须通过此校验才能落库，
 * 防止非法走法/抢走造成的房间-对局状态不一致。
 *
 * 棋盘 board[row][col]，row 0..9（黑上红下），col 0..8；
 * from/to 均为 [row, col]。棋子 { type, color }，type ∈ r n b a k c p。
 */

export interface Piece { type: string; color: 'red' | 'black'; }
export type Board = (Piece | null)[][];

const inside = (r: number, c: number) => r >= 0 && r < 10 && c >= 0 && c < 9;

function clearPath(board: Board, fr: number, fc: number, tr: number, tc: number): boolean {
  if (fr === tr) {
    const lo = Math.min(fc, tc) + 1, hi = Math.max(fc, tc);
    for (let c = lo; c < hi; c++) if (board[fr][c]) return false;
    return true;
  }
  if (fc === tc) {
    const lo = Math.min(fr, tr) + 1, hi = Math.max(fr, tr);
    for (let r = lo; r < hi; r++) if (board[r][fc]) return false;
    return true;
  }
  return false;
}

/**
 * 基本走法规则校验（不含"走后应将"，与前端 Logic.ts 规则一致）。
 */
export function isPseudoLegal(board: Board, from: [number, number], to: [number, number]): boolean {
  const [fr, fc] = from, [tr, tc] = to;
  if (!inside(fr, fc) || !inside(tr, tc)) return false;
  const piece = board[fr]?.[fc];
  if (!piece) return false;
  const target = board[tr][tc];
  if (target && target.color === piece.color) return false; // 不能吃己方

  const dx = tc - fc, dy = tr - fr;
  const red = piece.color === 'red';

  switch (piece.type) {
    case 'r': // 车
      return (fr === tr || fc === tc) && clearPath(board, fr, fc, tr, tc);
    case 'c': { // 炮
      if (fr !== tr && fc !== tc) return false;
      let screen = 0;
      if (fr === tr) {
        const lo = Math.min(fc, tc) + 1, hi = Math.max(fc, tc);
        for (let c = lo; c < hi; c++) if (board[fr][c]) screen++;
      } else {
        const lo = Math.min(fr, tr) + 1, hi = Math.max(fr, tr);
        for (let r = lo; r < hi; r++) if (board[r][fc]) screen++;
      }
      return target ? screen === 1 : screen === 0;
    }
    case 'n': { // 马：日字 + 蹩马腿
      if (!((Math.abs(dx) === 2 && Math.abs(dy) === 1) || (Math.abs(dx) === 1 && Math.abs(dy) === 2))) return false;
      const legR = fr + (Math.abs(dy) === 2 ? Math.sign(dy) : 0);
      const legC = fc + (Math.abs(dx) === 2 ? Math.sign(dx) : 0);
      return !board[legR]?.[legC];
    }
    case 'b': { // 象：田字 + 塞象眼 + 不过河
      if (Math.abs(dx) !== 2 || Math.abs(dy) !== 2) return false;
      if (red && tr < 5) return false;
      if (!red && tr > 4) return false;
      return !board[fr + dy / 2]?.[fc + dx / 2];
    }
    case 'a': { // 士：九宫斜走
      if (Math.abs(dx) !== 1 || Math.abs(dy) !== 1) return false;
      if (tc < 3 || tc > 5) return false;
      if (red && (tr < 7 || tr > 9)) return false;
      if (!red && (tr < 0 || tr > 2)) return false;
      return true;
    }
    case 'k': { // 将/帅：九宫直走 + 白脸将
      if (Math.abs(dx) + Math.abs(dy) === 1) {
        if (tc < 3 || tc > 5) return false;
        if (red && (tr < 7 || tr > 9)) return false;
        if (!red && (tr < 0 || tr > 2)) return false;
        return true;
      }
      // 白脸将：同列中间无子可直取对方将
      if (dx === 0 && target?.type === 'k') {
        return clearPath(board, fr, fc, tr, tc);
      }
      return false;
    }
    case 'p': { // 兵/卒
      const forward = red ? -1 : 1;
      const crossed = red ? tr <= 4 : tr >= 5;
      if (dy === forward && dx === 0) return true;
      if (crossed && dy === 0 && Math.abs(dx) === 1) return true;
      return false;
    }
  }
  return false;
}

/** 走后己方将/帅是否安全（含将帅对脸） */
function kingSafe(board: Board, color: 'red' | 'black'): boolean {
  const enemy = color === 'red' ? 'black' : 'red';
  let kr = -1, kc = -1, er = -1, ec = -1;
  for (let r = 0; r < 10; r++) {
    for (let c = 0; c < 9; c++) {
      const p = board[r][c];
      if (!p) continue;
      if (p.type === 'k' && p.color === color) { kr = r; kc = c; }
      if (p.type === 'k' && p.color === enemy) { er = r; ec = c; }
    }
  }
  if (kr < 0) return false;
  // 将帅对脸
  if (kc === ec) {
    const lo = Math.min(kr, er) + 1, hi = Math.max(kr, er);
    let blocked = false;
    for (let r = lo; r < hi; r++) if (board[r][kc]) { blocked = true; break; }
    if (!blocked) return false;
  }
  // 敌方伪合法走法是否命中我方帅
  for (let r = 0; r < 10; r++) {
    for (let c = 0; c < 9; c++) {
      const p = board[r][c];
      if (!p || p.color !== enemy) continue;
      if (isPseudoLegal(board, [r, c], [kr, kc])) return false;
    }
  }
  return true;
}

/** 完整合法性：基本规则 + 走后自己不被将 */
export function isLegalMove(board: Board, from: [number, number], to: [number, number]): boolean {
  if (!isPseudoLegal(board, from, to)) return false;
  const mover = board[from[0]][from[1]]!;
  // 模拟走子
  const next = board.map(row => row.slice());
  next[to[0]][to[1]] = next[from[0]][from[1]];
  next[from[0]][from[1]] = null;
  return kingSafe(next, mover.color);
}

/**
 * 某方是否还有任意合法走法。
 * 用于权威判定"将死"（被将军且无合法应对）与"困毙"（未被将军但无子可走）：
 * 两种情况都判该方负。枚举该方所有棋子的所有目标格，只要存在一个合法走法即为 true。
 */
export function hasAnyLegalMove(board: Board, color: 'red' | 'black'): boolean {
  for (let r = 0; r < 10; r++) {
    for (let c = 0; c < 9; c++) {
      const p = board[r][c];
      if (!p || p.color !== color) continue;
      for (let tr = 0; tr < 10; tr++) {
        for (let tc = 0; tc < 9; tc++) {
          if (isLegalMove(board, [r, c], [tr, tc])) return true;
        }
      }
    }
  }
  return false;
}
