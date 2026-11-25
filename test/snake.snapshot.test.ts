/**
 * 服务端快照增量：拾取物的 `foodAdd` / `foodDel` / `foodMove` / `foodFull`。
 *
 * 为什么值得单独测：100+ 个食物每帧全量下发 → 带宽浪费；改成增量后，
 * 一旦 id 不稳定或增删算错，客户端就会「吃了没反应的果子」或「果子凭空消失」。
 *
 * `foodMove` 是磁铁吸附的通道：服务端把范围内食物往蛇头拉（改了 x/y），
 * 增删协议只带 id → 客户端食物纹丝不动，看起来就是「吸的效果没了」。
 */
import { describe, expect, test } from 'bun:test';
import { computeFoodPayload } from '../src/services/SnakeRuntimeService';
import type { SnakeFoodItem } from '../src/games/snake/rules';

const food = (id: number, x = 0, y = 0): SnakeFoodItem => ({ id, x, y, r: 8, v: 1, k: 0 });
/** 上一帧坐标表：id → 坐标 */
const prevOf = (...ids: number[]) => new Map(ids.map(id => [id, { x: 0, y: 0 }]));

describe('贪吃蛇快照 · 拾取物增量', () => {
  test('全量帧：整表下发并标记 foodFull', () => {
    const p = computeFoodPayload(prevOf(), [food(1), food(2)], true);
    expect(p.foodFull).toBe(true);
    expect(p.food?.map(f => f.id)).toEqual([1, 2]);
    // 全量帧不带增删字段，客户端按「整表替换」处理
    expect(p.foodAdd).toBeUndefined();
    expect(p.foodDel).toBeUndefined();
    expect(p.foodMove).toBeUndefined();
  });

  test('增量帧：只发新增的，带上消失的 id', () => {
    const p = computeFoodPayload(prevOf(1, 2, 3), [food(2), food(3), food(4)], false);
    expect(p.foodFull).toBe(false);
    expect(p.foodAdd?.map(f => f.id)).toEqual([4]);
    expect(p.foodDel).toEqual([1]);
    expect(p.food).toBeUndefined();
  });

  test('增量帧：无变化时两个数组都是空的（不是 null）', () => {
    const p = computeFoodPayload(prevOf(1, 2), [food(1), food(2)], false);
    expect(p.foodAdd).toEqual([]);
    expect(p.foodDel).toEqual([]);
  });

  test('增量帧：食物全被吃光 → 全部进 foodDel', () => {
    const p = computeFoodPayload(prevOf(1, 2, 3), [], false);
    expect(p.foodAdd).toEqual([]);
    expect(p.foodDel?.sort((a, b) => a - b)).toEqual([1, 2, 3]);
  });

  test('食物重生：同一个 id 重新出现不会重复下发', () => {
    // id 是稳定自增的：被吃的 id 不会被复用，重生是新 id
    const p = computeFoodPayload(prevOf(1), [food(1), food(7)], false);
    // 1 还在（没被吃）→ 不重复发；7 是新 id → 发
    expect(p.foodAdd?.map(f => f.id)).toEqual([7]);
    expect(p.foodDel).toEqual([]);
  });

  test('载荷只带渲染与判定需要的字段（不带内部字段）', () => {
    const p = computeFoodPayload(prevOf(), [food(1)], true);
    expect(Object.keys(p.food![0]).sort()).toEqual(['id', 'k', 'r', 'v', 'x', 'y']);
  });

  test('foodMove：坐标变了才报位移（磁铁吸附）', () => {
    const prev = new Map([[1, { x: 100, y: 100 }], [2, { x: 200, y: 200 }]]);
    const p = computeFoodPayload(prev, [food(1, 130, 90), food(2, 200, 200)], false);
    expect(p.foodMove).toEqual([{ id: 1, x: 130, y: 90 }]);
  });

  test('foodMove：新出现的拾取物不算位移（它的坐标由 foodAdd 带）', () => {
    const p = computeFoodPayload(prevOf(1), [food(1, 0, 0), food(2, 50, 50)], false);
    expect(p.foodMove).toEqual([]);
    expect(p.foodAdd?.map(f => f.id)).toEqual([2]);
  });

  test('foodMove：全量帧不报位移（整表已经带坐标）', () => {
    const prev = new Map([[1, { x: 100, y: 100 }]]);
    const p = computeFoodPayload(prev, [food(1, 130, 90)], true);
    expect(p.foodMove).toBeUndefined();
  });
});
