// 五子棋AI类
export default class GomokuAI {
  width: number;
  height: number;
  empty: 0
  player1: number;
  player2: number;
  score: { [key: string]: number };
  zobrist: Zobrist;
  transTable: Map<number, any>;
  dirs: number[][];
  private patterns: Map<number, { regex: RegExp, score: number }[]> = new Map();
  private preparePatterns(p: number) {
    const self = p.toString();
    const opp = p === 1 ? "2" : "1";
    const e = "0"; // empty

    const pList: [string, number][] = [
      // 1. 连五
      [self.repeat(5), this.score.FIVE],

      // 2. 活四 (011110)
      [e + self.repeat(4) + e, this.score.LIVE_FOUR],

      // 3. 冲四 (211110, 011112, 11011, 11101, 10111)
      [opp + self.repeat(4) + e, this.score.SLEEP_FOUR],
      [e + self.repeat(4) + opp, this.score.SLEEP_FOUR],
      [self.repeat(2) + e + self.repeat(2), this.score.SLEEP_FOUR],
      [self + e + self.repeat(3), this.score.SLEEP_FOUR],
      [self.repeat(3) + e + self, this.score.SLEEP_FOUR],

      // 4. 活三 (01110, 010110, 011010)
      [e + self.repeat(3) + e, this.score.LIVE_THREE],
      [e + self + e + self.repeat(2) + e, this.score.LIVE_THREE],
      [e + self.repeat(2) + e + self + e, this.score.LIVE_THREE],

      // 5. 冲三 (补全：211100, 001112, 211010, 210110, 010112, 011012, 以及跳冲三)
      [opp + self.repeat(3) + e + e, this.score.SLEEP_THREE],
      [e + e + self.repeat(3) + opp, this.score.SLEEP_THREE],
      [opp + self.repeat(2) + e + self + e, this.score.SLEEP_THREE],
      [opp + self + e + self.repeat(2) + e, this.score.SLEEP_THREE],
      [e + self + e + self.repeat(2) + opp, this.score.SLEEP_THREE],
      [e + self.repeat(2) + e + self + opp, this.score.SLEEP_THREE],
      [self + e + e + self.repeat(2), this.score.SLEEP_THREE], // 10011
      [self.repeat(2) + e + e + self, this.score.SLEEP_THREE], // 11001
      [self + e + self + e + self, this.score.SLEEP_THREE],    // 10101 (这种也算冲三)
    ];

    this.patterns.set(p, pList.map(([str, score]) => ({
      // 使用正则全局匹配，利用前瞻断言 (?=...) 可以匹配重叠棋型而不消耗字符
      regex: new RegExp(`(?=(${str}))`, 'g'),
      score
    })));
  }

  constructor(width: number = 15, height: number = 15) {
    this.width = width;
    this.height = height;
    this.empty = 0;      // 空位标记
    this.player1 = 1;    // 黑棋（通常AI执黑，可根据需要调整）
    this.player2 = 2;    // 白棋
    // 棋型分数（从高到低）
    this.score = {
      FIVE: 100000,      // 连五
      LIVE_FOUR: 10000,  // 活四
      SLEEP_FOUR: 1000,  // 冲四（死四）
      LIVE_THREE: 1000,  // 活三
      SLEEP_THREE: 100,  // 眠三
      LIVE_TWO: 100,     // 活二
      SLEEP_TWO: 10,     // 眠二
    };

    this.preparePatterns(1);
    this.preparePatterns(2);
    // Zobrist 哈希表
    this.zobrist = new Zobrist(width, height, 3); // 3种状态（空、黑、白）
    this.transTable = new Map(); // 置换表 { hash: { depth, score, flag, bestMove } }

    // 方向向量：水平、垂直、对角线、反对角线
    this.dirs = [[1, 0], [0, 1], [1, 1], [1, -1]];
  }

  // 公开接口：传入当前棋盘（二维数组），当前要走的玩家（1或2），搜索深度，返回最佳落子 { x, y }
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
        board[move.x][move.y] = currentPlayer;
        let score = -this.alphaBeta(board, this.opponent(currentPlayer), d - 1, -beta, -alpha);
        board[move.x][move.y] = this.empty; // 回溯
        if (score >= this.score.FIVE) {
          return bestMove;
        }
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

    // 深度为0(搜索达到预定深度) 或 直接胜负已分（用快速检测）
    if (depth === 0) {
      let score = this.evaluate(board, player); // 评估当前玩家视角
      return score;
    }

    let moves = this.generateMoves(board);
    if (moves.length === 0) return 0; // 平局

    // 走法排序：根据历史启发或简单按位置中心度排序
    moves = this.orderMoves(moves);

    let bestScore = -Infinity;
    let bestMove: { x: number, y: number } | null = null;
    let flag = 'upper'; // 默认当前节点是上界（因为没更新alpha）

    for (let move of moves) {
      board[move.x][move.y] = player;
      let score = -this.alphaBeta(board, this.opponent(player), depth - 1, -beta, -alpha);
      board[move.x][move.y] = this.empty;

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

  // 生成候选走法：只考虑已有棋子周围1格内的空位
  generateMoves(board: number[][]) {
    let moves: { x: number, y: number }[] = [];
    let visited = Array(this.width).fill([]).map(() => Array(this.height).fill(false));

    for (let r = 0; r < this.width; r++) {
      for (let c = 0; c < this.height; c++) {
        if (board[r][c] !== this.empty) {
          // 周围1格内
          for (let dr = -1; dr <= 1; dr++) {
            for (let dc = -1; dc <= 1; dc++) {
              let nr = r + dr, nc = c + dc;
              if (nr >= 0 && nr < this.width && nc >= 0 && nc < this.height &&
                board[nr][nc] === this.empty && !visited[nr][nc]) {
                visited[nr][nc] = true;
                moves.push({ x: nr, y: nc });
              }
            }
          }
        }
      }
    }
    // 如果棋盘为空（第一步），返回中心点
    if (moves.length === 0 && this.width > 0 && this.height > 0) {
      moves.push({ x: Math.floor(this.width / 2), y: Math.floor(this.height / 2) });
    }
    return moves;
  }

  // 简单走法排序：按距离棋盘中心距离升序（中心优先）
  orderMoves(moves: { x: number, y: number }[]) {
    let center = { x: (this.width - 1) / 2, y: (this.height - 1) / 2 };
    return moves.sort((a, b) => {
      let da = Math.hypot(a.x - center.x, a.y - center.y);
      let db = Math.hypot(b.x - center.x, b.y - center.y);
      return da - db;
    });
  }

  // 重新排序（用于迭代加深后，把最佳走法放前面）
  reorderMoves(moves: { x: number, y: number }[], bestMove: { x: number, y: number }) {
    return moves.sort((a, b) => {
      if (a.x === bestMove.x && a.y === bestMove.y) return -1;
      if (b.x === bestMove.x && b.y === bestMove.y) return 1;
      return 0;
    });
  }
  /**
   * 对单条线进行棋型分析
   */
  private scoreLine(line: number[], p: number): number {
    const s = line.join("");
    const pSet = this.patterns.get(p)!;
    let total = 0;

    for (const item of pSet) {
      // 使用 matchAll 直接获取所有匹配（包括重叠）
      const matches = Array.from(s.matchAll(item.regex));
      if (matches.length > 0) {
        total += matches.length * item.score;
      }
    }
    return total;
  }
  // 评估函数：返回从当前玩家视角的分数（正值有利）
  evaluate(board: number[][], player: number): number {
    const width = board.length;
    const height = board[0].length;
    const opponent = player === 1 ? 2 : 1;

    let playerScore = 0;
    let opponentScore = 0;

    // 1. 横向扫描 (Rows)
    for (let y = 0; y < height; y++) {
      const line: number[] = [];
      for (let x = 0; x < width; x++) line.push(board[x][y]);
      playerScore += this.scoreLine(line, player);
      opponentScore += this.scoreLine(line, opponent);
    }

    // 2. 纵向扫描 (Cols)
    for (let x = 0; x < width; x++) {
      const line = board[x];
      playerScore += this.scoreLine(line, player);
      opponentScore += this.scoreLine(line, opponent);
    }

    // 3. 正斜线 (Top-left to bottom-right)
    for (let i = 1 - height; i < width; i++) {
      const line: number[] = [];
      for (let x = 0; x < width; x++) {
        const y = x - i;
        if (y >= 0 && y < height) line.push(board[x][y]);
      }
      if (line.length >= 5) {
        playerScore += this.scoreLine(line, player);
        opponentScore += this.scoreLine(line, opponent);
      }
    }

    // 4. 反斜线 (Top-right to bottom-left)
    for (let i = 0; i < width + height - 1; i++) {
      const line: number[] = [];
      for (let x = 0; x < width; x++) {
        const y = i - x;
        if (y >= 0 && y < height) line.push(board[x][y]);
      }
      if (line.length >= 5) {
        playerScore += this.scoreLine(line, player);
        opponentScore += this.scoreLine(line, opponent);
      }
    }

    return playerScore - opponentScore;
  }
  opponent(player: number) {
    return player === this.player1 ? this.player2 : this.player1;
  }
}

// Zobrist 哈希类
class Zobrist {
  width: number;
  height: number;
  states: number;
  table: any;
  constructor(width: number, height: number, states: any) {
    this.width = width;
    this.height = height;
    this.states = states; // 棋子状态数（空、黑、白）
    this.table = [];
    this.init();
  }

  init() {
    for (let i = 0; i < this.width; i++) {
      this.table[i] = [];
      for (let j = 0; j < this.height; j++) {
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
    for (let i = 0; i < this.width; i++) {
      for (let j = 0; j < this.height; j++) {
        let state = board[i][j]; // 0空 1黑 2白
        if (state !== 0) {
          h ^= this.table[i][j][state];
        }
      }
    }
    return h;
  }

  // 更新哈希（落子时使用，可选）
  update(hash: number, x: number, y: number, oldState: number, newState: number) {
    hash ^= this.table[x][y][oldState];
    hash ^= this.table[x][y][newState];
    return hash;
  }
}
