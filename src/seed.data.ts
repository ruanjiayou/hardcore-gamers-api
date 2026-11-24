/**
 * 内置种子数据（纯数据，无数据库副作用，便于校验与测试）
 * - 游戏 slug 必须与 server/src/games、lobby/src/games、robot 的注册键一致
 * - 机器人账号必须存在且 type=robot/state=online，否则 addRobot 永远返回 false
 */

import { GameGenre, PlayerType, PlayerState, RoomStatus } from './constant';
import type { IGame, IRoom, IVoicePack } from './types';
import { snakeTeamRoles, snakeTeamSeats } from './games/snake/teams';

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
    _id: 'chess',
    slug: 'chess',
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
  {
    _id: 'tetris',
    slug: 'tetris',
    title: '俄罗斯方块',
    desc: '经典俄罗斯方块，7 种方块的旋转与消行，等级越高下落越快。单人模式，成绩计入排行榜。',
    icon: '🧱',
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
  {
    _id: 'snake',
    slug: 'snake',
    title: '贪吃蛇',
    desc: '经典贪吃蛇：虚拟摇杆任意方向实时转向，无尽挑战 1–10 人同图刷分（死亡弹框选重生/退出），团队模式 6 队同场竞技（每队最多 5 人）。',
    icon: '🐍',
    genre: GameGenre.puzzle,
    // 两种玩法都是房间制：官方桌提前建好，进房即玩
    mode: 'room',
    status: 1,
    numbers: { min: 1, max: 10 },
    variants: [
      {
        key: 'endless',
        label: '无尽挑战',
        mode: 'room',
        board: 'endless',
        desc: '1–10 人同图刷分，任意方向转向，死亡即记榜，弹框选重生（3s 无敌）或退出',
        numbers: { min: 1, max: 10 },
      },
      {
        key: 'team',
        label: '团队模式',
        mode: 'room',
        board: 'team',
        desc: '最多 6 队同场竞技，每队最多 5 人；队友之间不会互相碰撞，最后存活的一队获胜',
        numbers: { min: 2, max: 30 },
        teams: snakeTeamRoles(),
      },
    ],
    boards: [
      { key: 'endless', label: '无尽榜' },
      { key: 'team', label: '团队榜' },
    ],
    role_config: {
      mode: 'team',
      roles: snakeTeamRoles(),
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
    // 每种房间玩法变体各建一组官方桌（贪吃蛇：无尽 4 桌 + 团队 4 桌）。
    // 无变体的游戏沿用老命名 official-{slug}-{i}；有变体时团队桌保留老 id（老库不迁移），
    // 其余变体加后缀，避免与已存在的官方桌撞号。
    const variants = (game.variants || []).filter(v => v.mode === 'room');
    const groups = variants.length
      ? variants.map(v => ({
        variant: v.key,
        label: v.label,
        numbers: v.numbers || game.numbers,
        prefix: v.key === 'team' ? `official-${game.slug}` : `official-${game.slug}-${v.key}`,
      }))
      : [{ variant: '', label: '官方', numbers: game.numbers, prefix: `official-${game.slug}` }];

    for (const group of groups) {
      for (let i = 1; i <= OFFICIAL_ROOMS_PER_GAME; i++) {
        rooms.push({
          _id: `${group.prefix}-${i}`,
          game_id: game._id,
          name: `${game.title} · ${group.label} ${i} 号桌`,
          status: RoomStatus.waiting,
          owner_id: '',
          members: [],
          // 团队模式预置座位（6 队 × 5 人）；其它玩法不占座
          seats: group.variant === 'team' ? snakeTeamSeats() : [],
          numbers: group.numbers,
          isPrivate: false,
          official: true,
          allowSpectate: true,
          transient: false,
          createdAt: new Date(),
          updatedAt: new Date(),
          settings: group.variant ? { variant: group.variant } : {},
        });
      }
    }
  }
  return rooms;
}

/** 机器人账号：贪吃蛇 5 个（无尽桌要坐满人机），其余游戏各一个。用固定 _id 保证幂等、可被识别与回收。 */
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
  { user_id: 'robot-user-chess', player_id: 'robot-player-chess', user_name: '🤖 国际象棋大师', game_id: 'chess', slug: 'chess' },
  // 贪吃蛇 5 个人机：沿用最早的 robot-player-snake（避免留下孤儿账号），其余顺延
  { user_id: 'robot-user-snake', player_id: 'robot-player-snake', user_name: '🤖 贪吃蛇 1 号', game_id: 'snake', slug: 'snake' },
  ...[2, 3, 4, 5].map(i => ({
    user_id: `robot-user-snake-${i}`,
    player_id: `robot-player-snake-${i}`,
    user_name: `🤖 贪吃蛇 ${i} 号`,
    game_id: 'snake',
    slug: 'snake',
  })),
];

/** 官方无尽房要配的人机数量 */
export const SNAKE_ENDLESS_BOT_COUNT = 5;

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

/**
 * 语音包种子：配置只引用音频文件 URL，文件自托管在 server/public/audio/ 下，
 * 前端按 URL 加载播放。素材均为 OpenGameArt CC0（可商用、无需署名）。
 * - 目录约定：audio/<包>/common/ 放通用 BGM 与 click/win/lose；
 *   audio/<包>/<gameId>/{move,collect}.mp3 是该游戏专属操作音。
 * - 每套语音包在 7 个游戏上各有不同的 move/collect 音效，由下方 games 字段配置。
 * - classic：默认包，所有玩家（含游客）可用
 * - ambient / arcade：需权限，权限位在 users.voicePackPerm 或 etcd voice_pack_allowlist
 */
export const SEED_VOICE_PACKS: IVoicePack[] = [
  {
    _id: 'classic',
    name: '经典',
    desc: '轻快的默认音效，七个游戏各有专属操作音',
    cover: '🎵',
    isDefault: true,
    requirePermission: false,
    bgm: [{ url: '/audio/classic/common/bgm.mp3', label: '经典主题' }],
    sfx: {
      click: '/audio/classic/common/click.mp3',
      win: '/audio/classic/common/win.mp3',
      lose: '/audio/classic/common/lose.mp3',
    },
    status: 1,
    createdAt: new Date(),
    updatedAt: new Date(),
  },
  {
    _id: 'ambient',
    name: '深空',
    desc: '空灵的环境氛围，七个游戏各有柔和提示音',
    cover: '🌌',
    isDefault: false,
    requirePermission: true,
    bgm: [
      { url: '/audio/ambient/common/bgm.mp3', label: '星域' },
      { url: '/audio/ambient/common/bgm2.mp3', label: '漂浮' },
    ],
    sfx: {
      click: '/audio/ambient/common/click.mp3',
      win: '/audio/ambient/common/win.mp3',
      lose: '/audio/ambient/common/lose.mp3',
    },
    status: 1,
    createdAt: new Date(),
    updatedAt: new Date(),
  },
  {
    _id: 'arcade',
    name: '街机',
    desc: '明快的电子节奏，七个游戏各有清脆操作音',
    cover: '🕹️',
    isDefault: false,
    requirePermission: true,
    bgm: [{ url: '/audio/arcade/common/bgm.mp3', label: '霓虹' }],
    sfx: {
      click: '/audio/arcade/common/click.mp3',
      win: '/audio/arcade/common/win.mp3',
      lose: '/audio/arcade/common/lose.mp3',
    },
    status: 1,
    createdAt: new Date(),
    updatedAt: new Date(),
  },
];

/** 每个包的 7 个游戏各自的操作音；sfx 按 key 覆盖包级通用配置 */
const AUDIO_GAME_IDS = ['gomoku', 'xiangqi', 'othello', 'chess', '2048', 'tetris', 'snake'];
for (const pack of SEED_VOICE_PACKS) {
  pack.games = Object.fromEntries(AUDIO_GAME_IDS.map(game => [game, {
    sfx: {
      move: `/audio/${pack._id}/${game}/move.mp3`,
      collect: `/audio/${pack._id}/${game}/collect.mp3`,
    },
  }]));
}
