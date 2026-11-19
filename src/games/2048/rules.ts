/**
 * 2048 服务端校验规则。
 * 游戏本体在前端本地实时运行（键盘/滑动、动画、计分），服务端不重放每一步，
 * 只在结束时对上报的分数做权威性校验，防止明显作弊（负数、非整数、超上限）。
 */

/** 单局分数上限：4x4 棋盘理论极限约 2^18 量级，取一个宽松但能挡住乱填的值。 */
export const MAX_SCORE = 2_000_000;

export interface ScoreCheck {
  valid: boolean;
  score: number;
  reason?: string;
}

/**
 * 校验前端上报的分数。
 * - 必须是有限非负整数
 * - 不超过 MAX_SCORE
 */
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
