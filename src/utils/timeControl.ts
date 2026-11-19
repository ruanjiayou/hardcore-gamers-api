/**
 * 象棋计时（读秒制）核心规则 - 纯函数，无 IO，便于测试。
 *
 * 规则：
 * - 每步思考时间 <= stepLimitMs：不扣总额度；
 * - 超过 stepLimitMs：超出部分从该玩家 personal total budget 扣除；
 * - 额度扣到 0：该玩家判负（由上层服务广播 game-over）。
 *
 * 时间统一用毫秒；服务器时间是唯一权威，客户端只做展示倒计时。
 */

export interface TimeControlConfig {
  enabled: boolean;
  stepLimitSec: number; // 每步限时（秒）
  totalBudgetMin: number; // 每人总时长（分钟）
}

export interface MatchTimeControl {
  enabled: boolean;
  stepLimitMs: number;
  budgetMs: number;
  remaining: Record<string, number>; // playerId -> 剩余额度 ms
  turnStartedAt: Record<string, number>; // playerId -> 当前回合开始的服务端时间戳 ms
}

export const DEFAULT_TIME_CONTROL: TimeControlConfig = {
  enabled: false,
  stepLimitSec: 30,
  totalBudgetMin: 10,
};

const clamp = (n: any, min: number, max: number, fallback: number): number => {
  const v = Number(n);
  if (!Number.isFinite(v)) return fallback;
  return Math.min(max, Math.max(min, Math.round(v)));
};

/** 归一化房间配置，防止前端传入非法/越界值 */
export function normalizeTimeControl(raw?: Partial<TimeControlConfig> | null): TimeControlConfig {
  if (!raw) return { ...DEFAULT_TIME_CONTROL };
  return {
    enabled: raw.enabled === true,
    stepLimitSec: clamp(raw.stepLimitSec, 5, 300, DEFAULT_TIME_CONTROL.stepLimitSec),
    totalBudgetMin: clamp(raw.totalBudgetMin, 1, 120, DEFAULT_TIME_CONTROL.totalBudgetMin),
  };
}

/** 开局时构建对局内的计时状态快照 */
export function buildMatchTimeControl(
  config: TimeControlConfig,
  playerIds: string[],
  now: number,
): MatchTimeControl {
  const budgetMs = clamp(config.totalBudgetMin, 1, 120, 10) * 60 * 1000;
  const remaining: Record<string, number> = {};
  const turnStartedAt: Record<string, number> = {};
  playerIds.forEach(id => {
    remaining[id] = budgetMs;
    turnStartedAt[id] = now;
  });
  return {
    enabled: config.enabled === true,
    stepLimitMs: clamp(config.stepLimitSec, 5, 300, 30) * 1000,
    budgetMs,
    remaining,
    turnStartedAt,
  };
}

/** 某玩家在 now 时刻的“投影剩余额度”：扣掉本回合超出步时限的部分（只读，不改状态） */
export function projectedRemaining(tc: MatchTimeControl, playerId: string, now: number): number {
  const base = tc.remaining[playerId] ?? tc.budgetMs;
  const startedAt = tc.turnStartedAt[playerId] ?? now;
  const overtime = Math.max(0, now - startedAt - tc.stepLimitMs);
  return base - overtime;
}

/** 当前回合玩家是否已经把额度耗尽（<=0 判负） */
export function findTimeout(tc: MatchTimeControl, currTurn: string, now: number): string | null {
  if (!tc.enabled) return null;
  return projectedRemaining(tc, currTurn, now) <= 0 ? currTurn : null;
}

/**
 * 落子时结算本回合耗时，返回新的计时状态与是否超时。
 * 结算只扣“超出步时限的部分”，并把下一回合的开始时间设为 now。
 */
export function settleMove(
  tc: MatchTimeControl,
  moverId: string,
  nextId: string | undefined,
  now: number,
): { state: MatchTimeControl; overtimeMs: number; timedOut: boolean } {
  const startedAt = tc.turnStartedAt[moverId] ?? now;
  const overtimeMs = Math.max(0, now - startedAt - tc.stepLimitMs);
  const remaining = { ...tc.remaining };
  remaining[moverId] = Math.max(0, (remaining[moverId] ?? tc.budgetMs) - overtimeMs);

  const turnStartedAt = { ...tc.turnStartedAt, [moverId]: now };
  if (nextId) turnStartedAt[nextId] = now;

  return {
    state: { ...tc, remaining, turnStartedAt },
    overtimeMs,
    timedOut: remaining[moverId] <= 0,
  };
}

/** 生成给客户端的时钟快照 */
export function clockSnapshot(
  matchId: string,
  tc: MatchTimeControl,
  currTurn: string,
  serverNow: number,
) {
  return {
    match_id: matchId,
    enabled: tc.enabled,
    stepLimitMs: tc.stepLimitMs,
    budgetMs: tc.budgetMs,
    remaining: tc.remaining,
    turnStartedAt: tc.turnStartedAt,
    curr_turn: currTurn,
    serverNow,
  };
}
