/**
 * 俄罗斯方块服务端校验规则。
 * 与 2048 同一套模式：棋盘/消行/落块全部在 lobby 前端本地实时运行，
 * 服务端不重放每一步，只对上报的分数做权威性校验并计入排行榜。
 *
 * 这里同时提供「消行计分」纯函数，供单测覆盖计分模型
 * （前端 Logic 使用同一公式，保证前后端口径一致）。
 */

/** 单局分数上限：等级无上限时分数可无限增长，取一个宽松但能挡住乱填的值。 */
export const MAX_SCORE = 5_000_000;

/** 消行基础分：1/2/3/4 行（4 行 = Tetris，额外奖励） */
export const LINE_POINTS = [0, 100, 300, 500, 800] as const;

/** 每消 10 行升 1 级（从 1 级起） */
export const LINES_PER_LEVEL = 10;

export interface ScoreCheck {
  valid: boolean;
  score: number;
  reason?: string;
}

/** 校验前端上报的分数：有限非负整数，且不超过上限 */
export function checkScore(raw: unknown): ScoreCheck {
  if (typeof raw !== 'number' || !Number.isFinite(raw)) {
    return { valid: false, score: 0, reason: '分数非法' };
  }
  if (!Number.isInteger(raw)) {
    return { valid: false, score: 0, reason: '分数必须为整数' };
  }
  if (raw < 0) {
    return { valid: false, score: 0, reason: '分数不能为负' };
  }
  if (raw > MAX_SCORE) {
    return { valid: false, score: 0, reason: '分数超出上限' };
  }
  return { valid: true, score: raw };
}

/** 等级：每 10 行 +1 级 */
export function levelFor(lines: number): number {
  return 1 + Math.floor(Math.max(0, lines) / LINES_PER_LEVEL);
}

/** 一次消行的得分（受当前等级加成） */
export function lineClearScore(cleared: number, level: number): number {
  if (cleared <= 0) return 0;
  const base = LINE_POINTS[Math.min(cleared, 4)];
  return base * Math.max(1, level);
}

/** 重力间隔（毫秒）：等级越高下落越快，最低 60ms */
export function gravityMs(level: number): number {
  return Math.max(60, 800 - (Math.max(1, level) - 1) * 70);
}
