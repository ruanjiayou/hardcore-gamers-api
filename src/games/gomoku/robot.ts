// 五子棋AI类
export default class GomokuAI {
  rows: number;
  cols: number;
  empty: 0
  player1: number;
  player2: number;
  score: { [key: string]: number };
  zobrist: Zobrist;
  transTable: Map<number, any>;
  dirs: number[][];

  constructor(rows: number = 15, cols: number = 15) {
    this.rows = rows;
    this.cols = cols;
    this.empty = 0;      // 空位标记
    this.player1 = 1;    // 黑棋（通常AI执黑，可根据需要调整）
    this.player2 = 2;    // 白棋

    // 棋型分数（从高到低）
    this.score = {
      FIVE: 1000000,      // 连五
      LIVE_FOUR: 100000,  // 活四
      SLEEP_FOUR: 10000,  // 冲四（死四）
      LIVE_THREE: 5000,   // 活三
      SLEEP_THREE: 1000,  // 眠三
      LIVE_TWO: 500,      // 活二
      SLEEP_TWO: 100      // 眠二
    };

    // Zobrist 哈希表
    this.zobrist = new Zobrist(rows, cols, 3); // 3种状态（空、黑、白）
    this.transTable = new Map(); // 置换表 { hash: { depth, score, flag, bestMove } }

    // 方向向量：水平、垂直、对角线、反对角线
    this.dirs = [[1, 0], [0, 1], [1, 1], [1, -1]];
  }

  // 公开接口：传入当前棋盘（二维数组），当前要走的玩家（1或2），搜索深度，返回最佳落子 { row, col }
  getBestMove(board: number[][], currentPlayer: number, depth = 4) {
    // 初始化走法列表
    let moves = this.generateMoves(board);
    if (moves.length === 0) return null; // 棋盘已满

    // 使用迭代加深，优先用浅层搜索结果作为深层搜索的启发
    let bestMove = moves[0];
    for (let d = 1; d <= depth; d++) {
      let alpha = -Infinity;
      let beta = Infinity;
      let bestScore = -Infinity;
      for (let move of moves) {
        // 尝试落子
        board[move.row][move.col] = currentPlayer;
        let score = -this.alphaBeta(board, this.opponent(currentPlayer), d - 1, -beta, -alpha);
        board[move.row][move.col] = this.empty; // 回溯

        if (score > bestScore) {
          bestScore = score;
          bestMove = move;
        }
        alpha = Math.max(alpha, bestScore);
      }
      // 每加深一层，可以用最佳走法重新排序走法列表，提高剪枝效率
      moves = this.reorderMoves(moves, bestMove);
    }
    return bestMove;
  }

  // α-β递归
  alphaBeta(board: number[][], player: number, depth: number, alpha: number, beta: number) {
    // 置换表查询
    const hash = this.zobrist.hash(board);
    const entry = this.transTable.get(hash);
    if (entry && entry.depth >= depth) {
      if (entry.flag === 'exact') return entry.score;
      if (entry.flag === 'lower') alpha = Math.max(alpha, entry.score);
      if (entry.flag === 'upper') beta = Math.min(beta, entry.score);
      if (alpha >= beta) return entry.score;
    }

    // 深度为0 或 直接胜负已分（用快速检测）
    if (depth === 0) {
      let score = this.evaluate(board, player); // 评估当前玩家视角
      return score;
    }

    let moves = this.generateMoves(board);
    if (moves.length === 0) return 0; // 平局

    // 走法排序：根据历史启发或简单按位置中心度排序
    moves = this.orderMoves(moves);

    let bestScore = -Infinity;
    let bestMove = null;
    let flag = 'upper'; // 默认当前节点是上界（因为没更新alpha）

    for (let move of moves) {
      board[move.row][move.col] = player;
      let score = -this.alphaBeta(board, this.opponent(player), depth - 1, -beta, -alpha);
      board[move.row][move.col] = this.empty;

      if (score > bestScore) {
        bestScore = score;
        bestMove = move;
      }
      alpha = Math.max(alpha, bestScore);
      if (alpha >= beta) {
        flag = 'lower'; // 剪枝，说明实际值至少为alpha
        break;
      }
    }

    // 存入置换表
    let entryFlag = 'exact';
    if (bestScore <= alpha) entryFlag = 'upper';
    else if (bestScore >= beta) entryFlag = 'lower';
    this.transTable.set(hash, {
      depth: depth,
      score: bestScore,
      flag: entryFlag,
      bestMove: bestMove
    });

    return bestScore;
  }

  // 生成候选走法：只考虑已有棋子周围2格内的空位
  generateMoves(board: number[][]) {
    let moves = [];
    let visited = Array(this.rows).fill([]).map(() => Array(this.cols).fill(false));

    for (let r = 0; r < this.rows; r++) {
      for (let c = 0; c < this.cols; c++) {
        if (board[r][c] !== this.empty) {
          // 周围2格内
          for (let dr = -2; dr <= 2; dr++) {
            for (let dc = -2; dc <= 2; dc++) {
              let nr = r + dr, nc = c + dc;
              if (nr >= 0 && nr < this.rows && nc >= 0 && nc < this.cols &&
                board[nr][nc] === this.empty && !visited[nr][nc]) {
                visited[nr][nc] = true;
                moves.push({ row: nr, col: nc });
              }
            }
          }
        }
      }
    }
    // 如果棋盘为空（第一步），返回中心点
    if (moves.length === 0 && this.rows > 0 && this.cols > 0) {
      moves.push({ row: Math.floor(this.rows / 2), col: Math.floor(this.cols / 2) });
    }
    return moves;
  }

  // 简单走法排序：按距离棋盘中心距离升序（中心优先）
  orderMoves(moves: { row: number, col: number }[]) {
    let center = { row: (this.rows - 1) / 2, col: (this.cols - 1) / 2 };
    return moves.sort((a, b) => {
      let da = Math.hypot(a.row - center.row, a.col - center.col);
      let db = Math.hypot(b.row - center.row, b.col - center.col);
      return da - db;
    });
  }

  // 重新排序（用于迭代加深后，把最佳走法放前面）
  reorderMoves(moves: { row: number, col: number }[], bestMove: { row: number, col: number }) {
    return moves.sort((a, b) => {
      if (a.row === bestMove.row && a.col === bestMove.col) return -1;
      if (b.row === bestMove.row && b.col === bestMove.col) return 1;
      return 0;
    });
  }

  // 评估函数：返回从当前玩家视角的分数（正值有利）
  evaluate(board: number[][], player: number) {
    let total = 0;
    for (let r = 0; r < this.rows; r++) {
      for (let c = 0; c < this.cols; c++) {
        if (board[r][c] !== this.empty) {
          let color = board[r][c];
          let sign = (color === player) ? 1 : -1; // 我方为正，对方为负
          // 检查四个方向（每个方向只统计一次，避免重复）
          for (let [dx, dy] of this.dirs) {
            // 只统计从当前点向正方向延伸，避免重复计算同一条线
            // 简单起见，我们统计每个棋子各个方向的棋型，但会有重复，但影响不大（可简化）
            let count = 1;
            let blockLeft = 0, blockRight = 0;

            // 正方向延伸
            for (let step = 1; step < 5; step++) {
              let nr = r + step * dx, nc = c + step * dy;
              if (nr < 0 || nr >= this.rows || nc < 0 || nc >= this.cols) {
                blockRight++; break;
              }
              if (board[nr][nc] === color) count++;
              else if (board[nr][nc] === this.empty) break;
              else { blockRight++; break; }
            }
            // 负方向延伸
            for (let step = 1; step < 5; step++) {
              let nr = r - step * dx, nc = c - step * dy;
              if (nr < 0 || nr >= this.rows || nc < 0 || nc >= this.cols) {
                blockLeft++; break;
              }
              if (board[nr][nc] === color) count++;
              else if (board[nr][nc] === this.empty) break;
              else { blockLeft++; break; }
            }

            // 根据 count 和阻挡情况赋予分数（简化：只考虑连续棋子数）
            let block = blockLeft + blockRight;
            if (count >= 5) total += sign * this.score.FIVE;
            else if (count === 4) {
              if (block === 0) total += sign * this.score.LIVE_FOUR;
              else total += sign * this.score.SLEEP_FOUR;
            } else if (count === 3) {
              if (block === 0) total += sign * this.score.LIVE_THREE;
              else total += sign * this.score.SLEEP_THREE;
            } else if (count === 2) {
              if (block === 0) total += sign * this.score.LIVE_TWO;
              else total += sign * this.score.SLEEP_TWO;
            }
            // 更精细的棋型可自行扩展
          }
        }
      }
    }
    return total;
  }

  opponent(player: number) {
    return player === this.player1 ? this.player2 : this.player1;
  }
}

// Zobrist 哈希类
class Zobrist {
  rows: number;
  cols: number;
  states: number;
  table: any;
  constructor(rows: number, cols: number, states: any) {
    this.rows = rows;
    this.cols = cols;
    this.states = states; // 棋子状态数（空、黑、白）
    this.table = [];
    this.init();
  }

  init() {
    for (let i = 0; i < this.rows; i++) {
      this.table[i] = [];
      for (let j = 0; j < this.cols; j++) {
        this.table[i][j] = [];
        for (let s = 0; s < this.states; s++) {
          // 生成随机64位整数（JavaScript用BigInt模拟，但简单起见用普通整数）
          this.table[i][j][s] = Math.floor(Math.random() * Number.MAX_SAFE_INTEGER);
        }
      }
    }
  }

  // 根据当前棋盘计算哈希值
  hash(board: number[][]) {
    let h = 0;
    for (let i = 0; i < this.rows; i++) {
      for (let j = 0; j < this.cols; j++) {
        let state = board[i][j]; // 0空 1黑 2白
        if (state !== 0) {
          h ^= this.table[i][j][state];
        }
      }
    }
    return h;
  }

  // 更新哈希（落子时使用，可选）
  update(hash: number, row: number, col: number, oldState: number, newState: number) {
    hash ^= this.table[row][col][oldState];
    hash ^= this.table[row][col][newState];
    return hash;
  }
}
