import { describe, test, expect } from 'bun:test';
import { SEED_GAMES, SEED_ROBOTS, robotPlayerSeed, officialRoomSeeds, OFFICIAL_ROOMS_PER_GAME, SNAKE_ENDLESS_BOT_COUNT } from '../src/seed.data';

describe('种子数据一致性', () => {
  test('基础游戏：五子棋、象棋、黑白棋、国际象棋、2048、俄罗斯方块、贪吃蛇', () => {
    expect(SEED_GAMES.length).toBe(7);
    const slugs = SEED_GAMES.map(g => g.slug).sort();
    expect(slugs).toEqual(['2048', 'chess', 'gomoku', 'othello', 'snake', 'tetris', 'xiangqi']);
    const soloSlugs = ['2048', 'tetris'];
    SEED_GAMES.forEach(g => {
      expect(g._id).toBe(g.slug);
      expect(g.title).toBeTruthy();
      if (soloSlugs.includes(g.slug)) {
        // 单人游戏：主页直接开始，无需房间
        expect(g.mode).toBe('solo');
        expect(g.numbers.min).toBe(1);
        expect(g.numbers.max).toBe(1);
      } else if (g.slug === 'snake') {
        // 两种玩法都是房间制：无尽 1–10 人同图、团队 6 队×5 人（最多 30 人）淘汰
        expect(g.mode).toBe('room');
        expect(g.numbers.max).toBe(10);
        expect(g.variants?.map(v => v.key).sort()).toEqual(['endless', 'team']);
        const endless = g.variants?.find(v => v.key === 'endless');
        const team = g.variants?.find(v => v.key === 'team');
        expect(endless?.mode).toBe('room');
        expect(endless?.numbers?.max).toBe(10);
        expect(team?.mode).toBe('room');
        expect(team?.numbers?.max).toBe(30);
        expect(g.boards?.map(b => b.key).sort()).toEqual(['endless', 'team']);
        // 团队模式：6 队，每队 5 人
        expect(g.role_config).toEqual({
          mode: 'team',
          roles: [
            { name: '红队', size: 5 },
            { name: '蓝队', size: 5 },
            { name: '黄队', size: 5 },
            { name: '绿队', size: 5 },
            { name: '紫队', size: 5 },
            { name: '橙队', size: 5 },
          ],
        });
        expect(team?.teams).toEqual(g.role_config.roles);
      } else {
        // 棋类：房间制
        expect(g.mode).toBe('room');
        expect(g.numbers.min).toBe(2);
        expect(g.numbers.max).toBe(2);
      }
    });
  });

  test('官方公共房：每个房间制游戏 4 桌，单人游戏不建房', () => {
    const rooms = officialRoomSeeds();
    const roomGames = SEED_GAMES.filter(g => g.mode === 'room');
    // 有玩法变体的游戏（贪吃蛇）每种房间玩法各建一组官方桌
    const groups = roomGames.reduce((n, g) => {
      const variants = (g.variants || []).filter(v => v.mode === 'room');
      return n + Math.max(1, variants.length);
    }, 0);
    expect(rooms.length).toBe(groups * OFFICIAL_ROOMS_PER_GAME);
    // _id 固定且唯一，保证 seed 幂等
    const ids = rooms.map(r => r._id);
    expect(new Set(ids).size).toBe(ids.length);
    rooms.forEach(r => {
      expect(r.official).toBe(true);
      expect(r.allowSpectate).toBe(true);
      expect(r.transient).toBe(false);
      expect(r.isPrivate).toBe(false);
      expect(r.status).toBe('waiting');
      expect(r.members).toEqual([]);
      expect(SEED_GAMES.some(g => g._id === r.game_id)).toBe(true);
    });
    // 单人游戏（2048 / 俄罗斯方块）不产生官方房
    expect(rooms.some(r => r.game_id === '2048')).toBe(false);
    expect(rooms.some(r => r.game_id === 'tetris')).toBe(false);
    // 每个房间制游戏：每种房间玩法各 4 桌（无变体的棋类只有一组）
    roomGames.forEach(g => {
      const variants = (g.variants || []).filter(v => v.mode === 'room');
      const perGame = Math.max(1, variants.length) * OFFICIAL_ROOMS_PER_GAME;
      expect(rooms.filter(r => r.game_id === g._id).length).toBe(perGame);
    });
    // 贪吃蛇：无尽 4 桌 + 团队 4 桌
    const snakeRooms = rooms.filter(r => r.game_id === 'snake');
    expect(snakeRooms.length).toBe(OFFICIAL_ROOMS_PER_GAME * 2);
    expect(snakeRooms.filter(r => r.settings?.variant === 'endless').length).toBe(OFFICIAL_ROOMS_PER_GAME);
    expect(snakeRooms.filter(r => r.settings?.variant === 'team').length).toBe(OFFICIAL_ROOMS_PER_GAME);
    // 无尽桌按 1–10 人配置
    snakeRooms.filter(r => r.settings?.variant === 'endless')
      .forEach(r => expect(r.numbers).toEqual({ min: 1, max: 10 }));
    // 团队桌按 6 队 × 5 人配置，并带队伍座位表
    snakeRooms.filter(r => r.settings?.variant === 'team')
      .forEach(r => {
        expect(r.numbers).toEqual({ min: 2, max: 30 });
        expect(r.seats?.length).toBe(6);
        expect(r.seats?.every(s => s.size === 5)).toBe(true);
      });
  });

  test('机器人账号：每个游戏至少一个、player_id 唯一；贪吃蛇有 5 个人机', () => {
    const slugs = SEED_ROBOTS.map(r => r.slug);
    ['chess', 'gomoku', 'othello', 'snake', 'xiangqi'].forEach(slug => {
      expect(slugs.includes(slug)).toBe(true);
    });
    // 贪吃蛇要多个人机填满官方无尽桌
    expect(SEED_ROBOTS.filter(r => r.slug === 'snake').length).toBe(SNAKE_ENDLESS_BOT_COUNT);
    const playerIds = SEED_ROBOTS.map(r => r.player_id);
    expect(new Set(playerIds).size).toBe(playerIds.length);
    const userIds = SEED_ROBOTS.map(r => r.user_id);
    expect(new Set(userIds).size).toBe(userIds.length);
    SEED_ROBOTS.forEach(r => {
      // 机器人所属 game_id 必须能在基础游戏里找到
      expect(SEED_GAMES.some(g => g._id === r.game_id)).toBe(true);
    });
  });

  test('机器人玩家初始状态为 online/robot，才能被 addRobot 选中', () => {
    SEED_ROBOTS.forEach(r => {
      const player = robotPlayerSeed(r);
      expect(player.type).toBe('robot');
      expect(player.state).toBe('online');
      expect(player.game_id).toBe(r.game_id);
      expect(player.user_id).toBe(r.user_id);
      expect(player.room_id).toBe('');
    });
  });
});
