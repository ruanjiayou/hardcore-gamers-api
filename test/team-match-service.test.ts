import { describe, expect, test } from 'bun:test';
import { TeamMatchService } from '../src/services/TeamMatchService';

/**
 * 纯编排单测：用假 roomService / io 注入，不连 Mongo。
 * 关注「3 房凑齐 → 建 1 局 → 三房都收到 game-start」，以及不足 3 房只广播状态。
 */
function makeFakeDeps() {
  const emitted: { room: string; event: string; payload: any }[] = [];
  const created: { rooms: any[] }[] = [];
  const spawned: any[] = [];
  const io: any = {
    to(room: string) {
      return {
        emit(event: string, payload: any) {
          emitted.push({ room, event, payload });
        },
      };
    },
  };
  // 真实 RoomService.startTeamMatch 按 id 重新查库拿最新成员，这里用假库模拟
  const db = new Map<string, any>();
  const roomService: any = {
    seed(r: any) { db.set(r._id, r); },
    async startTeamMatch(refs: any[]) {
      const rooms = refs.map(r => db.get(r._id)).filter(Boolean);
      created.push({ rooms });
      return rooms.length >= 2 ? 'match-1' : '';
    },
  };
  const runtime: any = { spawn(match: any) { spawned.push(match); } };
  const matchProvider: any = {
    async findById(id: string) {
      if (id !== 'match-1') return null;
      return { _id: 'match-1', curr_state: { timeControl: undefined } };
    },
  };
  return { io, roomService, runtime, matchProvider, emitted, created, spawned };
}

const room = (id: string, members: string[]) => ({
  _id: id,
  game_id: 'game-snake',
  settings: { variant: 'team' },
  status: 'waiting',
  members: members.map(m => ({ _id: m, member_type: 'player' })),
  numbers: { min: 2, max: 5 },
});

describe('TeamMatchService 3 房合局编排', () => {
  test('不足 3 房只广播 team-match-status，不建局', async () => {
    const d = makeFakeDeps();
    const svc = new TeamMatchService(d.roomService as any, d.runtime as any, d.matchProvider as any);
    svc.setIO(d.io);
    const r1 = room('r1', ['a', 'b']);

    const result = await svc.markReady(r1 as any);
    expect(result.match_id).toBe('');
    expect(result.need).toBe(2);
    expect(d.created).toHaveLength(0);
    expect(d.emitted.some(e => e.event === 'room:team-match-status')).toBe(true);
  });

  test('凑齐 3 房建 1 局，队伍按房间顺序，三房都收到 game-start', async () => {
    const d = makeFakeDeps();
    const svc = new TeamMatchService(d.roomService as any, d.runtime as any, d.matchProvider as any);
    svc.setIO(d.io);
    d.roomService.seed(room('r1', ['a', 'b']));
    d.roomService.seed(room('r2', ['c', 'd']));
    d.roomService.seed(room('r3', ['e']));

    await svc.markReady(room('r1', ['a', 'b']) as any);
    await svc.markReady(room('r2', ['c', 'd']) as any);
    const result = await svc.markReady(room('r3', ['e']) as any);

    expect(result.match_id).toBe('match-1');
    expect(result.room_ids).toEqual(['r1', 'r2', 'r3']);
    expect(d.created).toHaveLength(1);
    const players = d.created[0].rooms.flatMap((r: any) => r.members);
    expect(players).toHaveLength(5);

    const starts = d.emitted.filter(e => e.event === 'room:game-start');
    expect(starts.map(s => s.room).sort()).toEqual(['room:r1', 'room:r2', 'room:r3']);
    expect(new Set(starts.map(s => s.payload.match_id)).size).toBe(1);
    expect(d.spawned).toHaveLength(1);
  });

  test('重复点开始的房不会重复入池', async () => {
    const d = makeFakeDeps();
    const svc = new TeamMatchService(d.roomService as any, d.runtime as any, d.matchProvider as any);
    svc.setIO(d.io);
    await svc.markReady(room('r1', ['a', 'b']) as any);
    await svc.markReady(room('r1', ['a', 'b']) as any);
    expect(svc.readyCount('game-snake')).toBe(1);
  });

  test('房间离开/解散时从池中移除', async () => {
    const d = makeFakeDeps();
    const svc = new TeamMatchService(d.roomService as any, d.runtime as any, d.matchProvider as any);
    svc.setIO(d.io);
    await svc.markReady(room('r1', ['a']) as any);
    await svc.markReady(room('r2', ['c']) as any);
    svc.cancel('game-snake', 'r1');
    expect(svc.readyCount('game-snake')).toBe(1);
    await svc.markReady(room('r3', ['e']) as any);
    expect(d.created).toHaveLength(0); // 只有 r2 + r3，不足 3
  });
});
