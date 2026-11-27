import { describe, expect, test } from 'bun:test';
import {
  joinTeamPool,
  removeFromTeamPool,
  assignTeamsByRoom,
  TEAM_MATCH_ROOMS,
} from '../src/services/teamMatchPolicy';
import {
  SNAKE_TEAM_COUNT,
  SNAKE_TEAM_NAMES,
  SNAKE_TEAM_SIZE,
  SNAKE_TEAM_TOTAL,
} from '../src/games/snake/teams';

describe('GM-snake-36 / SB-064 团队房 5 人单队、3 房合局', () => {
  test('队伍配置：3 队 × 5 人 = 15 人', () => {
    expect(SNAKE_TEAM_COUNT).toBe(3);
    expect(SNAKE_TEAM_NAMES).toEqual(['红队', '蓝队', '黄队']);
    expect(SNAKE_TEAM_SIZE).toBe(5);
    expect(SNAKE_TEAM_TOTAL).toBe(15);
  });

  test('合局需要 3 个队房', () => {
    expect(TEAM_MATCH_ROOMS).toBe(3);
  });
});

describe('teamMatchPolicy.joinTeamPool', () => {
  test('第 1、2 房就绪但未满，need 递减', () => {
    const s1 = joinTeamPool([], 'r1');
    expect(s1.roomIds).toEqual(['r1']);
    expect(s1.need).toBe(2);
    expect(s1.full).toBe(false);

    const s2 = joinTeamPool(s1.roomIds, 'r2');
    expect(s2.roomIds).toEqual(['r1', 'r2']);
    expect(s2.need).toBe(1);
    expect(s2.full).toBe(false);
  });

  test('第 3 房就绪触发合局，full=true', () => {
    const s3 = joinTeamPool(['r1', 'r2'], 'r3');
    expect(s3.roomIds).toEqual(['r1', 'r2', 'r3']);
    expect(s3.need).toBe(0);
    expect(s3.full).toBe(true);
  });

  test('同一房重复点开始不重复入池', () => {
    const s = joinTeamPool(['r1', 'r2'], 'r2');
    expect(s.roomIds).toEqual(['r1', 'r2']);
    expect(s.full).toBe(false);
  });

  test('满池后再来第 4 房不进入已合局池', () => {
    const s = joinTeamPool(['r1', 'r2', 'r3'], 'r4');
    expect(s.roomIds).toEqual(['r1', 'r2', 'r3']);
    expect(s.full).toBe(true);
  });

  test('removeFromTeamPool 移除解散/离开的房', () => {
    const left = removeFromTeamPool(['r1', 'r2', 'r3'], 'r2');
    expect(left).toEqual(['r1', 'r3']);
  });
});

describe('teamMatchPolicy.assignTeamsByRoom', () => {
  const rooms: any[] = [
    { _id: 'r1', members: [{ _id: 'a' }, { _id: 'b' }] },
    { _id: 'r2', members: [{ _id: 'c' }, { _id: 'd' }] },
    { _id: 'r3', members: [{ _id: 'e' }] },
  ];

  test('每个房间的全体成员分配为同一队，队伍按房间顺序', () => {
    const merged = assignTeamsByRoom(rooms as any);
    expect(merged.roomIds).toEqual(['r1', 'r2', 'r3']);
    expect(merged.players).toHaveLength(5);
    const byId = Object.fromEntries(merged.players.map((p: any) => [p._id, p.team]));
    expect(byId).toEqual({
      a: '红队', b: '红队',
      c: '蓝队', d: '蓝队',
      e: '黄队',
    });
  });

  test('覆盖成员自带的 team（进房时不再分队，旧数据也不作数）', () => {
    const withStale: any[] = [
      { _id: 'r1', members: [{ _id: 'a', team: '绿队' }] },
    ];
    const merged = assignTeamsByRoom(withStale as any);
    expect(merged.players[0].team).toBe('红队');
  });

  test('不足 3 房时按实际房数分队', () => {
    const merged = assignTeamsByRoom(rooms.slice(0, 2) as any);
    expect(merged.roomIds).toEqual(['r1', 'r2']);
    expect(merged.players.map((p: any) => p.team)).toEqual(['红队', '红队', '蓝队', '蓝队']);
  });

  test('超过 3 房只取前 3 房', () => {
    const four = [...rooms, { _id: 'r4', members: [{ _id: 'f' }] }];
    const merged = assignTeamsByRoom(four as any);
    expect(merged.roomIds).toEqual(['r1', 'r2', 'r3']);
    expect(merged.players.some((p: any) => p._id === 'f')).toBe(false);
  });

  test('保留 member_type / player_type / nickname 等字段', () => {
    const full: any[] = [
      { _id: 'r1', members: [{ _id: 'a', member_type: 'player', player_type: 'robot', nickname: 'Bot' }] },
    ];
    const merged = assignTeamsByRoom(full as any);
    expect(merged.players[0]).toMatchObject({
      _id: 'a', member_type: 'player', player_type: 'robot', nickname: 'Bot', team: '红队',
    });
  });
});

describe('GameSnake.assignRole 团队房不再进房分队', () => {
  test('源码中 assignRole 不再写 member.team / 调用 pickTeam', async () => {
    const { readFileSync } = await import('node:fs');
    const src = readFileSync(new URL('../src/games/snake/index.ts', import.meta.url), 'utf8');
    const start = src.indexOf('static assignRole(');
    const end = src.indexOf('static assignRoles(');
    const body = src.slice(start, end);
    expect(start).toBeGreaterThan(-1);
    expect(body).not.toContain('.team');
    expect(body).not.toContain('pickTeam');
    expect(body).toContain("player.role = 'snake'");
  });
});
