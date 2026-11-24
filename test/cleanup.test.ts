import { describe, test, expect } from 'bun:test';
import {
  isDanglingRoomRef,
  isZombieMatch,
  isZombieRoom,
} from '../src/utils/roomPolicy';
import constant from '../src/constant';

describe('遗留数据清理判定（纯函数）', () => {
  test('悬空 room_id：房间不存在', () => {
    expect(isDanglingRoomRef({ _id: 'p1', room_id: 'r1' }, null)).toBe(true);
    expect(isDanglingRoomRef({ _id: 'p1', room_id: 'r1' }, undefined)).toBe(true);
  });

  test('悬空 room_id：房间已软删', () => {
    const room = { _id: 'r1', status: constant.ROOM.STATUS.deleted, members: [{ _id: 'p1' }] };
    expect(isDanglingRoomRef({ _id: 'p1', room_id: 'r1' }, room)).toBe(true);
  });

  test('悬空 room_id：房间还在但玩家已不在成员表里（最隐蔽的一种）', () => {
    const room = { _id: 'r1', status: constant.ROOM.STATUS.playing, members: [{ _id: 'other' }] };
    expect(isDanglingRoomRef({ _id: 'p1', room_id: 'r1' }, room)).toBe(true);
  });

  test('悬空 room_id：玩家确实在成员表里 → 不悬空', () => {
    const room = { _id: 'r1', status: constant.ROOM.STATUS.playing, members: [{ _id: 'p1' }] };
    expect(isDanglingRoomRef({ _id: 'p1', room_id: 'r1' }, room)).toBe(false);
  });

  test('悬空 room_id：玩家本来就没房间 → 不算悬空', () => {
    expect(isDanglingRoomRef({ _id: 'p1', room_id: '' }, null)).toBe(false);
    expect(isDanglingRoomRef({ _id: 'p1' }, null)).toBe(false);
  });

  test('僵尸对局：房间不存在 / 已解散 / match_id 对不上', () => {
    const match = { _id: 'm1', room_id: 'r1' };
    expect(isZombieMatch(match, null)).toBe(true);
    expect(isZombieMatch(match, { _id: 'r1', status: constant.ROOM.STATUS.deleted, match_id: 'm1' })).toBe(true);
    expect(isZombieMatch(match, { _id: 'r1', status: constant.ROOM.STATUS.waiting, match_id: 'm2' })).toBe(true);
  });

  test('僵尸对局：房间存活且 match_id 对得上 → 正常', () => {
    const match = { _id: 'm1', room_id: 'r1' };
    expect(isZombieMatch(match, { _id: 'r1', status: constant.ROOM.STATUS.playing, match_id: 'm1' })).toBe(false);
  });

  test('僵尸房间：停在 playing 但对局已不在进行中集合', () => {
    expect(isZombieRoom({ _id: 'r1', status: constant.ROOM.STATUS.playing, match_id: 'm1' }, new Set(['m2']))).toBe(true);
    expect(isZombieRoom({ _id: 'r1', status: constant.ROOM.STATUS.playing, match_id: 'm1' }, new Set(['m1']))).toBe(false);
  });

  test('僵尸房间：等待态 / 没有 match_id → 不算僵尸', () => {
    expect(isZombieRoom({ _id: 'r1', status: constant.ROOM.STATUS.waiting, match_id: 'm1' }, new Set())).toBe(false);
    expect(isZombieRoom({ _id: 'r1', status: constant.ROOM.STATUS.playing, match_id: '' }, new Set())).toBe(false);
  });
});
