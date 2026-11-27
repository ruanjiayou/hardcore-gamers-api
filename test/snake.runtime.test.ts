/**
 * 运行时归属：一个房间只允许一个贪吃蛇运行时。
 *
 * 为什么重要：运行时按 match_id 存内存，但房间会换对局。旧对局的运行时没停干净，
 * 新对局又开一个运行时，两个就会同时往同一个 socket 频道广播快照 ——
 * 客户端一半的帧里找不到自己的蛇，「已出局」提示每 50ms 闪一次（SB-053）。
 */
import { describe, expect, test } from 'bun:test';
import { pickStaleRuntime } from '../src/services/SnakeRuntimeService';

describe('贪吃蛇运行时 · 同房间唯一性', () => {
  test('同房间的旧对局要被挑出来停掉', () => {
    const list = [
      { match_id: 'm-old', room_id: 'r1' },
      { match_id: 'm-new', room_id: 'r1' },
    ];
    expect(pickStaleRuntime(list, 'r1', 'm-new')).toBe('m-old');
  });

  test('同一个对局自己不算冲突', () => {
    const list = [{ match_id: 'm1', room_id: 'r1' }];
    expect(pickStaleRuntime(list, 'r1', 'm1')).toBeNull();
  });

  test('别的房间的运行时不受影响', () => {
    const list = [
      { match_id: 'm-other', room_id: 'r2' },
      { match_id: 'm-new', room_id: 'r1' },
    ];
    expect(pickStaleRuntime(list, 'r1', 'm-new')).toBeNull();
  });

  test('没有运行时时返回 null', () => {
    expect(pickStaleRuntime([], 'r1', 'm-new')).toBeNull();
  });

  test('同房间堆了多个旧运行时时也能挑出第一个（后续由 spawn 逐个清）', () => {
    const list = [
      { match_id: 'm-a', room_id: 'r1' },
      { match_id: 'm-b', room_id: 'r1' },
      { match_id: 'm-new', room_id: 'r1' },
    ];
    expect(pickStaleRuntime(list, 'r1', 'm-new')).toBe('m-a');
  });

  test('新对局换房间时不会误伤原房间的运行时', () => {
    const list = [{ match_id: 'm-old', room_id: 'r1' }];
    expect(pickStaleRuntime(list, 'r2', 'm-new')).toBeNull();
  });
});

describe('贪吃蛇运行时 · 团队合局 3 房共 1 运行时（SB-064）', () => {
  test('合局运行时覆盖任一房间都算命中', () => {
    const list = [{ match_id: 'm-old', room_id: 'r1', room_ids: ['r1', 'r2', 'r3'] }];
    expect(pickStaleRuntime(list as any, 'r2', 'm-new')).toBe('m-old');
    expect(pickStaleRuntime(list as any, 'r3', 'm-new')).toBe('m-old');
  });

  test('同一合局的 3 房不算互相冲突', () => {
    const list = [{ match_id: 'm1', room_id: 'r1', room_ids: ['r1', 'r2', 'r3'] }];
    expect(pickStaleRuntime(list as any, 'r2', 'm1')).toBeNull();
  });

  test('快照要广播到全部参与房间', () => {
    const roomsOf = (rt: any) => (rt.room_ids?.length ? rt.room_ids : [rt.room_id]);
    expect(roomsOf({ room_id: 'r1', room_ids: ['r1', 'r2', 'r3'] })).toEqual(['r1', 'r2', 'r3']);
    expect(roomsOf({ room_id: 'solo' })).toEqual(['solo']);
  });
});
