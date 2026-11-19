import { describe, test, expect } from "bun:test";
import {
  normalizeTimeControl,
  buildMatchTimeControl,
  projectedRemaining,
  findTimeout,
  settleMove,
  clockSnapshot,
  DEFAULT_TIME_CONTROL,
} from "../src/utils/timeControl";

describe("计时配置归一化", () => {
  test("空配置返回默认值（默认不启用）", () => {
    expect(normalizeTimeControl()).toEqual(DEFAULT_TIME_CONTROL);
  });
  test("越界值被钳制", () => {
    const tc = normalizeTimeControl({ enabled: true, stepLimitSec: 999, totalBudgetMin: 0 });
    expect(tc.enabled).toBe(true);
    expect(tc.stepLimitSec).toBe(300);
    expect(tc.totalBudgetMin).toBe(1);
  });
  test("非法数字回落默认值", () => {
    const tc = normalizeTimeControl({ stepLimitSec: NaN as any, totalBudgetMin: "x" as any });
    expect(tc.stepLimitSec).toBe(30);
    expect(tc.totalBudgetMin).toBe(10);
  });
});

describe("读秒制结算", () => {
  const T0 = 1_000_000;
  const tc = buildMatchTimeControl(
    { enabled: true, stepLimitSec: 30, totalBudgetMin: 10 },
    ["red", "black"],
    T0,
  );

  test("开局每人 10 分钟，步时 30 秒", () => {
    expect(tc.remaining.red).toBe(600_000);
    expect(tc.remaining.black).toBe(600_000);
    expect(tc.stepLimitMs).toBe(30_000);
    expect(tc.turnStartedAt.red).toBe(T0);
  });

  test("思考未超过步时不扣总额度", () => {
    const rem = projectedRemaining(tc, "red", T0 + 29_000);
    expect(rem).toBe(600_000);
    expect(findTimeout(tc, "red", T0 + 29_000)).toBeNull();
  });

  test("超出步时的部分从总额度扣除（读秒制核心）", () => {
    // 思考 40s：前 30s 免费，超出 10s 从 600s 扣 -> 590s
    const rem = projectedRemaining(tc, "red", T0 + 40_000);
    expect(rem).toBe(590_000);
  });

  test("投影剩余不会立刻写回状态（只读）", () => {
    projectedRemaining(tc, "red", T0 + 100_000);
    expect(tc.remaining.red).toBe(600_000);
  });

  test("落子结算把超时部分扣掉，并重置下一回合起始时间", () => {
    const settled = settleMove(tc, "red", "black", T0 + 40_000);
    expect(settled.overtimeMs).toBe(10_000);
    expect(settled.state.remaining.red).toBe(590_000);
    expect(settled.state.turnStartedAt.black).toBe(T0 + 40_000);
    expect(settled.timedOut).toBe(false);
  });

  test("额度耗尽即超时判负", () => {
    // 思考 10min + 30s：超出 600s，额度归零
    const timeout = findTimeout(tc, "red", T0 + 630_000);
    expect(timeout).toBe("red");
  });

  test("未启用计时不判负", () => {
    const off = buildMatchTimeControl(
      { enabled: false, stepLimitSec: 30, totalBudgetMin: 10 },
      ["red", "black"], T0,
    );
    expect(findTimeout(off, "red", T0 + 9_000_000)).toBeNull();
  });

  test("结算后额度归零 timedOut=true", () => {
    const settled = settleMove(tc, "red", "black", T0 + 900_000);
    expect(settled.state.remaining.red).toBe(0);
    expect(settled.timedOut).toBe(true);
  });
});

describe("时钟快照", () => {
  test("快照含服务器时间与回合信息", () => {
    const T0 = 5_000;
    const tc = buildMatchTimeControl(
      { enabled: true, stepLimitSec: 20, totalBudgetMin: 5 }, ["r", "b"], T0,
    );
    const snap = clockSnapshot("m1", tc, "r", T0 + 1234);
    expect(snap.match_id).toBe("m1");
    expect(snap.curr_turn).toBe("r");
    expect(snap.serverNow).toBe(T0 + 1234);
    expect(snap.budgetMs).toBe(300_000);
    expect(snap.stepLimitMs).toBe(20_000);
  });
});
