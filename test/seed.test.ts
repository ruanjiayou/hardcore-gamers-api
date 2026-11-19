import { describe, test, expect } from 'bun:test';
import { SEED_GAMES, SEED_ROBOTS, robotPlayerSeed, officialRoomSeeds, OFFICIAL_ROOMS_PER_GAME } from '../src/seed.data';

describe('种子数据一致性', () => {
  test('基础游戏：五子棋、象棋、黑白棋、国际象棋、2048，slug 与 game_id 一致', () => {
    expect(SEED_GAMES.length).toBe(5);
    const slugs = SEED_GAMES.map(g => g.slug).sort();
    expect(slugs).toEqual(['2048', 'gomoku', 'international-chess', 'othello', 'xiangqi']);
    SEED_GAMES.forEach(g => {
      expect(g._id).toBe(g.slug);
      expect(g.title).toBeTruthy();
      if (g.slug === '2048') {
        // 单人游戏：主页直接开始，无需房间
        expect(g.mode).toBe('solo');
        expect(g.numbers.min).toBe(1);
        expect(g.numbers.max).toBe(1);
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
    expect(rooms.length).toBe(roomGames.length * OFFICIAL_ROOMS_PER_GAME);
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
    // 单人游戏（2048）不产生官方房
    expect(rooms.some(r => r.game_id === '2048')).toBe(false);
    // 每个房间制游戏恰好 4 桌
    roomGames.forEach(g => {
      expect(rooms.filter(r => r.game_id === g._id).length).toBe(OFFICIAL_ROOMS_PER_GAME);
    });
  });

  test('机器人账号，每个游戏一个，id 唯一', () => {
    expect(SEED_ROBOTS.length).toBe(4);
    const slugs = SEED_ROBOTS.map(r => r.slug).sort();
    expect(slugs).toEqual(['gomoku', 'international-chess', 'othello', 'xiangqi']);
    const playerIds = SEED_ROBOTS.map(r => r.player_id);
    expect(new Set(playerIds).size).toBe(playerIds.length);
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
