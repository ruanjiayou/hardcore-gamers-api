import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  buildPlayerProfile,
  buildPlayerUpdatePatch,
} from '../src/utils/playerProfile';

describe('SB-065 玩家资料只读模型（player 表，不含 user 敏感字段）', () => {
  test('只挑 player 字段，绝不暴露 user_id / email / phone / pass', () => {
    const raw: any = {
      _id: 'p-1',
      game_id: 'g-1',
      user_id: 'u-secret',
      nickname: '蛇王',
      avatar: '🐍',
      level: 7,
      score: 1234,
      exp: 88,
      boards: { endless: 999 },
      stats: { matches: 10, winners: 4, draws: 1, flees: 0 },
      email: 'a@b.com',
      phone: '13800000000',
      pass: 'hash',
    };
    const out: any = buildPlayerProfile(raw);
    expect(out.player_id).toBe('p-1');
    expect(out.nickname).toBe('蛇王');
    expect(out.avatar).toBe('🐍');
    expect(out.level).toBe(7);
    expect(out.score).toBe(1234);
    expect(out.exp).toBe(88);
    expect(out.boards).toEqual({ endless: 999 });
    expect(out.stats).toEqual({ matches: 10, winners: 4, draws: 1, flees: 0 });
    expect(out.win_rate).toBe(40);
    expect(JSON.stringify(out)).not.toContain('u-secret');
    expect(JSON.stringify(out)).not.toContain('a@b.com');
    expect(JSON.stringify(out)).not.toContain('13800000000');
    expect(JSON.stringify(out)).not.toContain('pass');
  });

  test('旧字段 stats.games / winnings 归一，win_rate 取整', () => {
    const out: any = buildPlayerProfile({
      _id: 'p-2',
      stats: { games: 3, winnings: 2 },
    });
    expect(out.stats).toEqual({ matches: 3, winners: 2, draws: 0, flees: 0 });
    expect(out.win_rate).toBe(67);
  });

  test('空 stats 与缺失字段给安全默认值', () => {
    const out: any = buildPlayerProfile({ _id: 'p-3' });
    expect(out.nickname).toBe('玩家');
    expect(out.level).toBe(1);
    expect(out.score).toBe(0);
    expect(out.win_rate).toBe(0);
  });
});

describe('SB-065 玩家可改字段白名单', () => {
  test('只接受 nickname / avatar', () => {
    expect(buildPlayerUpdatePatch({ nickname: '新名', avatar: '🦊' })).toEqual({
      nickname: '新名',
      avatar: '🦊',
    });
    expect(buildPlayerUpdatePatch({ nickname: '新名', level: 99, score: 9999 })).toEqual({
      nickname: '新名',
    });
  });

  test('昵称/头像校验同 VProfile：昵称 1-20，头像 ≤500', () => {
    expect(() => buildPlayerUpdatePatch({ nickname: '' })).toThrow();
    expect(() => buildPlayerUpdatePatch({ nickname: 'x'.repeat(21) })).toThrow();
    expect(() => buildPlayerUpdatePatch({ avatar: 'x'.repeat(501) })).toThrow();
  });

  test('空 patch 抛错', () => {
    expect(() => buildPlayerUpdatePatch({})).toThrow();
  });
});

describe('SB-065 路由挂载', () => {
  const read = (rel: string) => readFileSync(join(import.meta.dir, '..', rel), 'utf8');

  test('player controller 挂到 /api/players 并登记进 ROUTES', () => {
    const index = read('src/index.ts');
    expect(index).toContain("import playerController from './controller/player'");
    expect(index).toContain("['/api/players', playerController, 'player']");
  });

  test('四条接口路径齐全（含按 player_id 查对局记录）', () => {
    const src = read('src/controller/player.ts');
    expect(src).toContain("router.get('/:slug/profile/:player_id'");
    expect(src).toContain("router.get('/:slug/profile/:player_id/records'");
    expect(src).toContain("router.get('/:slug/me'");
    expect(src).toContain("router.put('/:slug/me'");
  });

  test('编辑接口必须校验归属（user_id + game_id + type）', () => {
    const src = read('src/controller/player.ts');
    expect(src).toContain('user_id: req.user_id!');
    expect(src).toContain("type: 'player'");
  });
});
