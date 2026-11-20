import { describe, test, expect } from 'bun:test';
import { normalizeMode, isSoloGame } from '../src/utils/gameMode';

describe('game mode 旧数据兜底（normalizeMode / isSoloGame）', () => {
  test('缺 mode 的 1 人游戏（旧 2048 记录）推断为 solo', () => {
    const old = { slug: '2048', numbers: { min: 1, max: 1 } } as any;
    expect(isSoloGame(old)).toBe(true);
    expect(normalizeMode(old).mode).toBe('solo');
  });

  test('缺 mode 的 2 人游戏推断为 room', () => {
    const old = { slug: 'xiangqi', numbers: { min: 2, max: 2 } } as any;
    expect(isSoloGame(old)).toBe(false);
    expect(normalizeMode(old).mode).toBe('room');
  });

  test('已有 mode 时不覆盖（显式 room 优先于人数推断）', () => {
    const g = { mode: 'room', numbers: { min: 1, max: 1 } } as any;
    expect(isSoloGame(g)).toBe(false);
    expect(normalizeMode(g).mode).toBe('room');
  });

  test('numbers 缺失时兜底为 room（安全默认）', () => {
    const g = { slug: 'x' } as any;
    expect(isSoloGame(g)).toBe(false);
    expect(normalizeMode(g).mode).toBe('room');
  });

  test('normalizeMode 原地修改并返回同一引用', () => {
    const g = { numbers: { min: 1, max: 1 } } as any;
    expect(normalizeMode(g)).toBe(g);
    expect(g.mode).toBe('solo');
  });
});
