/**
 * 玩法参数规格表（纯静态，不连数据库）：登记、校验、默认值判定。
 */
import { describe, it, expect } from 'bun:test';
import {
  GAME_PARAM_SPECS,
  getGameDefaultParams,
  hasGameParams,
  isGameParamsDefault,
  normalizeGameParams,
} from '../src/games/paramsRegistry';
import { DEFAULT_SNAKE_PARAMS, SNAKE_PARAM_RANGES } from '../src/games/snake/params';

describe('参数规格登记表', () => {
  it('贪吃蛇登记了可配置参数，其它游戏没有', () => {
    expect(hasGameParams('snake')).toBe(true);
    expect(hasGameParams('gomoku')).toBe(false);
  });

  it('默认值表与游戏的代码默认值一致', () => {
    expect(getGameDefaultParams('snake')).toEqual(DEFAULT_SNAKE_PARAMS);
    expect(getGameDefaultParams('gomoku')).toEqual({});
  });

  it('参数元信息覆盖全部字段，且默认值都落在合法区间内', () => {
    const spec = GAME_PARAM_SPECS.snake;
    const keys = spec.meta.map(m => m.key).sort();
    expect(keys).toEqual(Object.keys(DEFAULT_SNAKE_PARAMS).sort());
    for (const m of spec.meta) {
      expect(m.min).toBeLessThanOrEqual(m.default);
      expect(m.default).toBeLessThanOrEqual(m.max);
      expect(m.label).toBeTruthy();
      expect(m.group).toBeTruthy();
      expect(m.unit).toBeTruthy();
      expect(m.desc).toBeTruthy();
      // 区间与游戏自己的参数表保持一致（别写两份区间）
      expect(m.min).toBe(SNAKE_PARAM_RANGES[m.key as keyof typeof SNAKE_PARAM_RANGES].min);
      expect(m.max).toBe(SNAKE_PARAM_RANGES[m.key as keyof typeof SNAKE_PARAM_RANGES].max);
    }
  });
});

describe('管理端写入的参数校验', () => {
  it('存的是解析后的完整值（不是运营输入的片段）', () => {
    const saved = normalizeGameParams('snake', { speedMax: 90 });
    expect(saved.speedMax).toBe(90);
    expect(Object.keys(saved).sort()).toEqual(Object.keys(DEFAULT_SNAKE_PARAMS).sort());
    expect(saved.speedMin).toBe(DEFAULT_SNAKE_PARAMS.speedMin);
  });

  it('越界的值被裁剪，而不是原样存进去', () => {
    const saved = normalizeGameParams('snake', { speedMax: 99999, boostMult: 0.2 });
    expect(saved.speedMax).toBe(SNAKE_PARAM_RANGES.speedMax.max);
    expect(saved.boostMult).toBe(SNAKE_PARAM_RANGES.boostMult.min);
  });

  it('空配置等于「全部用默认值」', () => {
    const saved = normalizeGameParams('snake', {});
    expect(saved).toEqual(DEFAULT_SNAKE_PARAMS);
  });

  it('没登记参数的游戏不允许写 config', () => {
    expect(() => normalizeGameParams('gomoku', { speedMax: 90 })).toThrow();
  });

  it('配置不是对象时报错（避免把数组/字符串存进去）', () => {
    expect(() => normalizeGameParams('snake', null)).toThrow();
    expect(() => normalizeGameParams('snake', [1, 2])).toThrow();
  });
});

describe('默认值标记', () => {
  it('没配过 / 配成默认值 → 视为默认', () => {
    expect(isGameParamsDefault('snake', undefined)).toBe(true);
    expect(isGameParamsDefault('snake', {})).toBe(true);
    expect(isGameParamsDefault('snake', { ...DEFAULT_SNAKE_PARAMS })).toBe(true);
  });

  it('改了任一参数 → 视为已自定义', () => {
    expect(isGameParamsDefault('snake', { speedMax: 90 })).toBe(false);
  });

  it('没登记参数的游戏永远算默认（不会在列表里报「已自定义」）', () => {
    expect(isGameParamsDefault('gomoku', { whatever: 1 })).toBe(true);
  });
});
