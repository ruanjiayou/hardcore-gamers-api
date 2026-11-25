/**
 * 贪吃蛇可调参数：默认值、解析与「配置生效后两端一致」的验证。
 */
import { describe, it, expect } from 'bun:test';
import {
  DEFAULT_SNAKE_PARAMS,
  SNAKE_PARAM_RANGES,
  isDefaultSnakeParams,
  resolveSnakeParams,
} from '../src/games/snake/params';
import {
  createSnakeState,
  snakeCruiseSpeed,
  snakeMoveSpeed,
  snakeTurnRate,
  stepSnake,
} from '../src/games/snake/rules';

describe('贪吃蛇参数解析', () => {
  it('缺省时用代码默认值', () => {
    const p = resolveSnakeParams(undefined);
    expect(p).toEqual(DEFAULT_SNAKE_PARAMS);
    expect(isDefaultSnakeParams(undefined)).toBe(true);
  });

  it('数据库里配的值覆盖默认值', () => {
    const p = resolveSnakeParams({ speedMax: 90, boostMult: 2 });
    expect(p.speedMax).toBe(90);
    expect(p.boostMult).toBe(2);
    // 没配的字段仍是默认值
    expect(p.speedMin).toBe(DEFAULT_SNAKE_PARAMS.speedMin);
    expect(isDefaultSnakeParams({ speedMax: 90 })).toBe(false);
  });

  it('越界的值被裁剪到合法区间（而不是整个丢弃）', () => {
    const p = resolveSnakeParams({ speedMax: 99999, boostMult: -5 });
    expect(p.speedMax).toBe(SNAKE_PARAM_RANGES.speedMax.max);
    expect(p.boostMult).toBe(SNAKE_PARAM_RANGES.boostMult.min);
  });

  it('非法值（NaN / 字符串 / null）退回默认值', () => {
    const p = resolveSnakeParams({ speedMax: NaN, speedMin: 'fast' as any, boostMult: null });
    expect(p.speedMax).toBe(DEFAULT_SNAKE_PARAMS.speedMax);
    expect(p.speedMin).toBe(DEFAULT_SNAKE_PARAMS.speedMin);
    expect(p.boostMult).toBe(DEFAULT_SNAKE_PARAMS.boostMult);
  });

  it('交叉约束被修正：speedMin ≤ speedMax、boostMinLen ≤ bodyLength、maxLength ≥ bodyLength', () => {
    const p = resolveSnakeParams({ speedMax: 50, speedMin: 90, bodyLength: 300, boostMinLen: 500, maxLength: 100 });
    expect(p.speedMin).toBeLessThanOrEqual(p.speedMax);
    expect(p.boostMinLen).toBeLessThanOrEqual(p.bodyLength);
    expect(p.maxLength).toBeGreaterThanOrEqual(p.bodyLength);
  });
});

describe('参数驱动的速度模型', () => {
  it('默认参数下与代码默认值一致', () => {
    expect(snakeCruiseSpeed(DEFAULT_SNAKE_PARAMS.bodyLength)).toBeCloseTo(DEFAULT_SNAKE_PARAMS.speedMax, 5);
    expect(snakeCruiseSpeed(DEFAULT_SNAKE_PARAMS.maxLength)).toBeCloseTo(DEFAULT_SNAKE_PARAMS.speedMin, 5);
  });

  it('改了 speedMax 后巡航速度跟着变（这正是「改配置就生效」的核心）', () => {
    const p = resolveSnakeParams({ speedMax: 80 });
    expect(snakeCruiseSpeed(p.bodyLength, p)).toBeCloseTo(80, 5);
    expect(snakeCruiseSpeed(p.bodyLength)).toBeCloseTo(DEFAULT_SNAKE_PARAMS.speedMax, 5);
  });

  it('加速倍率与转弯半径可配置', () => {
    const p = resolveSnakeParams({ boostMult: 2.5, turnRadius: 10 });
    expect(snakeMoveSpeed(800, true, p)).toBeCloseTo(snakeCruiseSpeed(800, p) * 2.5, 5);
    expect(snakeTurnRate(800, false, p)).toBeCloseTo(snakeMoveSpeed(800, false, p) / 10, 5);
  });
});

describe('对局状态携带冻结的参数', () => {
  it('建局时参数被写进 state.params，整局不再变', () => {
    const p = resolveSnakeParams({ speedMax: 77 });
    const state = createSnakeState(['a'], { variant: 'endless', params: p });
    expect(state.params?.speedMax).toBe(77);
    // 建局后再改外部配置对象不影响已建的对局
    p.speedMax = 999;
    expect(state.params?.speedMax).toBe(77);
  });

  it('stepSnake 用 state.params 里的速度推进', () => {
    const p = resolveSnakeParams({ speedMax: 100 });
    const state = createSnakeState(['a'], { variant: 'endless', params: p });
    const s = state.snakes[0];
    s.angle = 0;
    s.targetAngle = 0;
    s.x = 500;
    s.y = 500;
    const before = s.x;
    // dt 会被 clamp 到 [0.004, 0.25]，所以按 0.2 秒算
    const dt = 0.2;
    stepSnake(state, { dt, now: Date.now() });
    // 一秒前进 ≈ 巡航速度（身长=初始 → speedMax）
    expect(s.x - before).toBeCloseTo(p.speedMax * dt, 0);
  });

  it('boostMinLen 可配置：身长不够时即使按住也不加速', () => {
    // 初始身长 100 < boostMinLen 500 → 按住也不该加速
    const p = resolveSnakeParams({ boostMinLen: 500, bodyLength: 100, maxLength: 2400 });
    const state = createSnakeState(['a'], { variant: 'endless', params: p });
    const s = state.snakes[0];
    s.boostHeld = true;
    s.x = 500; s.y = 500; s.angle = 0; s.targetAngle = 0;
    const before = s.x;
    const dt = 0.2;
    stepSnake(state, { dt, now: Date.now() });
    expect(s.x - before).toBeCloseTo(snakeMoveSpeed(100, false, p) * dt, 0);
  });

  it('boostDrain 可配置：加速扣身长按配置值', () => {
    const p = resolveSnakeParams({ boostDrain: 50, boostMinLen: 100 });
    const state = createSnakeState(['a'], { variant: 'endless', params: p });
    const s = state.snakes[0];
    s.boostHeld = true;
    s.x = 500; s.y = 500; s.angle = 0; s.targetAngle = 0;
    const lenBefore = s.length;
    const dt = 0.2;
    stepSnake(state, { dt, now: Date.now() });
    expect(lenBefore - s.length).toBeCloseTo(p.boostDrain * dt, 0);
  });

  it('bodyLength 可配置：新生的蛇按配置的身长', () => {
    const p = resolveSnakeParams({ bodyLength: 300 });
    const state = createSnakeState(['a'], { variant: 'endless', params: p });
    expect(state.snakes[0].length).toBe(300);
  });

  it('maxLength 可配置：吃食物不会超过上限', () => {
    const p = resolveSnakeParams({ maxLength: 500 });
    const state = createSnakeState(['a'], { variant: 'endless', params: p });
    const s = state.snakes[0];
    s.length = 490;
    s.x = 500; s.y = 500; s.angle = 0; s.targetAngle = 0;
    state.food.push({ id: 999, kind: 'food', x: 520, y: 500, v: 50, r: 8 });
    stepSnake(state, { dt: 0.05, now: Date.now() });
    expect(s.length).toBeLessThanOrEqual(p.maxLength);
  });
});
