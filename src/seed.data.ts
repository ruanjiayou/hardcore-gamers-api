/**
 * 内置种子数据（纯数据，无数据库副作用，便于校验与测试）
 * - 游戏 slug 必须与 server/src/games、lobby/src/games、robot 的注册键一致
 * - 机器人账号必须存在且 type=robot/state=online，否则 addRobot 永远返回 false
 */

import { GameGenre, PlayerType, PlayerState, RoomStatus } from './constant';
import type { IGame, IRoom } from './types';

export const SEED_GAMES: IGame[] = [
  {
    _id: 'gomoku',
    slug: 'gomoku',
    title: '五子棋',
    desc: '经典五子棋对战，黑方三三/四四/长连禁手，支持人机对弈与双人对局。',
    icon: '⚫',
    genre: GameGenre.puzzle,
    mode: 'room',
    status: 1,
    numbers: { min: 2, max: 2 },
    role_config: {
      mode: 'fixed',
      roles: [
        { name: '黑方', size: 1 },
        { name: '白方', size: 1 },
      ],
    },
    createdAt: new Date(),
    updatedAt: new Date(),
  },
  {
    _id: 'xiangqi',
    slug: 'xiangqi',
    title: '中国象棋',
    desc: '中国象棋，含开局库与残局知识，支持人机对弈与双人对局。',
    icon: '♟️',
    genre: GameGenre.puzzle,
    mode: 'room',
    status: 1,
    numbers: { min: 2, max: 2 },
    role_config: {
      mode: 'fixed',
      roles: [
        { name: '红方', size: 1 },
        { name: '黑方', size: 1 },
      ],
    },
    createdAt: new Date(),
    updatedAt: new Date(),
  },
  {
    _id: 'othello',
    slug: 'othello',
    title: '黑白棋',
    desc: '黑白棋（Reversi），翻转子棋争夺地盘，终局子数多者获胜，支持人机对弈。',
    icon: '⚪',
    genre: GameGenre.puzzle,
    mode: 'room',
    status: 1,
    numbers: { min: 2, max: 2 },
    role_config: {
      mode: 'fixed',
      roles: [
        { name: '黑方', size: 1 },
        { name: '白方', size: 1 },
      ],
    },
    createdAt: new Date(),
    updatedAt: new Date(),
  },
  {
    _id: 'international-chess',
    slug: 'international-chess',
    title: '国际象棋',
    desc: '国际象棋，含王车易位、吃过路兵、兵升变，将死获胜、逼和判和，支持人机对弈。',
    icon: '♞',
    genre: GameGenre.puzzle,
    mode: 'room',
    status: 1,
    numbers: { min: 2, max: 2 },
    role_config: {
      mode: 'fixed',
      roles: [
        { name: '白方', size: 1 },
        { name: '黑方', size: 1 },
      ],
    },
    createdAt: new Date(),
    updatedAt: new Date(),
  },
  {
    _id: '2048',
    slug: '2048',
    title: '2048',
    desc: '经典数字合成益智游戏，滑动合并相同数字冲击 2048。单人模式，成绩计入排行榜。',
    icon: '🔢',
    genre: GameGenre.puzzle,
    // 单人游戏：主页直接「开始游戏」开一局，不走房间
    mode: 'solo',
    status: 1,
    numbers: { min: 1, max: 1 },
    role_config: {
      mode: 'fixed',
      roles: [{ name: '玩家', size: 1 }],
    },
    createdAt: new Date(),
    updatedAt: new Date(),
  },
];

/**
 * 官方公共房：每个房间制游戏预建 4 个固定房（腾讯棋牌式大厅桌位）。
 * - official=true：不可解散，玩家只能退出；空房保留复用
 * - 固定 _id 保证 seed 幂等
 * - allowSpectate 默认开启，房主可在开局前关闭
 */
export const OFFICIAL_ROOMS_PER_GAME = 4;

export function officialRoomSeeds(): IRoom[] {
  const rooms: IRoom[] = [];
  for (const game of SEED_GAMES) {
    if (game.mode !== 'room') continue;
    for (let i = 1; i <= OFFICIAL_ROOMS_PER_GAME; i++) {
      rooms.push({
        _id: `official-${game.slug}-${i}`,
        game_id: game._id,
        name: `${game.title} · 官方 ${i} 号桌`,
        status: RoomStatus.waiting,
        owner_id: '',
        members: [],
        seats: [],
        numbers: game.numbers,
        isPrivate: false,
        official: true,
        allowSpectate: true,
        transient: false,
        createdAt: new Date(),
        updatedAt: new Date(),
        settings: {},
      });
    }
  }
  return rooms;
}

/** 机器人账号：每个游戏一个。用固定 _id 保证幂等、可被识别与回收。 */
export interface SeedRobot {
  user_id: string;
  player_id: string;
  user_name: string;
  game_id: string;
  slug: string;
}

export const SEED_ROBOTS: SeedRobot[] = [
  { user_id: 'robot-user-gomoku', player_id: 'robot-player-gomoku', user_name: '🤖 五子棋大师', game_id: 'gomoku', slug: 'gomoku' },
  { user_id: 'robot-user-xiangqi', player_id: 'robot-player-xiangqi', user_name: '🤖 象棋大师', game_id: 'xiangqi', slug: 'xiangqi' },
  { user_id: 'robot-user-othello', player_id: 'robot-player-othello', user_name: '🤖 黑白棋大师', game_id: 'othello', slug: 'othello' },
  { user_id: 'robot-user-international-chess', player_id: 'robot-player-international-chess', user_name: '🤖 国际象棋大师', game_id: 'international-chess', slug: 'international-chess' },
];

/** 机器人玩家的初始状态，供 seed 与回收逻辑共用 */
export function robotPlayerSeed(robot: SeedRobot) {
  return {
    _id: robot.player_id,
    user_id: robot.user_id,
    game_id: robot.game_id,
    room_id: '',
    nickname: robot.user_name,
    avatar: '🤖',
    title: 'AI',
    type: PlayerType.robot,
    level: 5,
    score: 0,
    exp: 0,
    status: 1,
    state: PlayerState.online,
    atline: true,
    stats: { games: 0, winners: 0, draws: 0, flees: 0, matches: 0 },
    createdAt: new Date(),
    updatedAt: new Date(),
  };
}
