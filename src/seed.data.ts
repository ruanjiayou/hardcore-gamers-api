/**
 * 内置种子数据（纯数据，无数据库副作用，便于校验与测试）
 * - 游戏 slug 必须与 server/src/games、lobby/src/games、robot 的注册键一致
 * - 机器人账号必须存在且 type=robot/state=online，否则 addRobot 永远返回 false
 */

import { GameGenre, PlayerType, PlayerState, RoomStatus } from './constant';
import type { IAsset, IAssetPack, IGame, IRoom } from './types';
import { snakeTeamRoles, snakeTeamSeats } from './games/snake/teams';

/** 种子时间戳固定，避免每次启动 `new Date()` 导致 diff/revision 抖动 */
export const SEED_TIME = new Date('2026-01-01T00:00:00.000Z');

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
        // 常驻竞技场：官方桌常驻 playing，玩家随时进出，房间只当内部容器
        arena: true,
      },
      {
        key: 'team',
        label: '团队模式',
        mode: 'room',
        board: 'team',
        desc: '5 人一队、3 队同场竞技；队友之间不会互相碰撞，最后存活的一队获胜',
        numbers: { min: 2, max: 5 },
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
        // 常驻竞技场玩法（贪吃蛇无尽）：房间只当内部容器，进房即开局、常驻 playing
        arena: v.arena === true,
        prefix: v.key === 'team' ? `official-${game.slug}` : `official-${game.slug}-${v.key}`,
      }))
      : [{ variant: '', label: '官方', numbers: game.numbers, arena: false, prefix: `official-${game.slug}` }];

    for (const group of groups) {
      for (let i = 1; i <= OFFICIAL_ROOMS_PER_GAME; i++) {
        rooms.push({
          _id: `${group.prefix}-${i}`,
          game_id: game._id,
          name: `${game.title} · ${group.label} ${i} 号桌`,
          status: RoomStatus.waiting,
          // 官方桌没有固定房主，只有运行期的「临时房主」（房内第一位真人对战玩家，SB-039）。
          // 人机永远不接房主位，否则管理端踢不掉它、房间也没人能解散/开局。
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
          // 常驻竞技场（贪吃蛇无尽）：房间只当内部容器，进房即开局、常驻 playing
          settings: group.variant
            ? { variant: group.variant, ...(group.arena ? { arena: true } : {}) }
            : {},
        });
      }
    }
  }
  return rooms;
}

/**
 * 机器人账号：贪吃蛇 5 个（无尽桌要坐满人机），其余游戏各一个。用固定 _id 保证幂等、可被识别与回收。
 * 昵称**不带 🤖 前缀**（UI-054）：机器人身份由玩家列表的「机」徽标和 🤖 头像体现，不再占昵称。
 */
export interface SeedRobot {
  user_id: string;
  player_id: string;
  user_name: string;
  game_id: string;
  slug: string;
  /** 人机难度（easy/normal/hard/master），缺省 normal；后台可改 */
  difficulty?: string;
}

export const SEED_ROBOTS: SeedRobot[] = [
  { user_id: 'robot-user-gomoku', player_id: 'robot-player-gomoku', user_name: '五子棋大师', game_id: 'gomoku', slug: 'gomoku' },
  { user_id: 'robot-user-xiangqi', player_id: 'robot-player-xiangqi', user_name: '象棋大师', game_id: 'xiangqi', slug: 'xiangqi' },
  { user_id: 'robot-user-othello', player_id: 'robot-player-othello', user_name: '黑白棋大师', game_id: 'othello', slug: 'othello' },
  { user_id: 'robot-user-chess', player_id: 'robot-player-chess', user_name: '国际象棋大师', game_id: 'chess', slug: 'chess' },
  // 贪吃蛇人机账号池：只有**第一个**官方无尽桌会补人机（每桌 2 个），
  // 多备几个是为了人机掉线后仍有空闲账号可替换（一个被占用就换一个）。
  // 沿用最早的 robot-player-snake（避免留下孤儿账号），其余顺延。
  { user_id: 'robot-user-snake', player_id: 'robot-player-snake', user_name: '贪吃蛇 1 号', game_id: 'snake', slug: 'snake' },
  ...[2, 3, 4, 5, 6, 7, 8, 9].map(i => ({
    user_id: `robot-user-snake-${i}`,
    player_id: `robot-player-snake-${i}`,
    user_name: `贪吃蛇 ${i} 号`,
    game_id: 'snake',
    slug: 'snake',
  })),
];

/**
 * 去掉昵称/登录名左侧的 🤖 前缀（UI-054）。
 *
 * 人机昵称不再带机器人 emoji：机器人身份由玩家列表的「机」徽标承担。
 * 早期 seed / admin 会把名字写成「🤖 贪吃蛇 1 号」，源头已改，
 * 但存量库 users.name / players.nickname 还带着前缀，
 * 由 seed 的 cleanRobotEmoji() 一次性洗掉，客户端不做兜底清洗。
 */
export function stripRobotEmoji(name?: string | null): string {
  return String(name ?? '').replace(/^\s*🤖\s*/u, '');
}

/** 第一个官方无尽房要配的人机数量 */
export const SNAKE_ENDLESS_BOT_COUNT = 2;

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
    // 人机难度默认普通（GM-snake-28），运营可在后台按人机逐个调整
    difficulty: robot.difficulty || 'normal',
    score: 0,
    exp: 0,
    status: 1,
    state: PlayerState.online,
    atline: true,
    // 统计口径统一为 {matches, winners, draws, flees}（旧字段 games/winnings 已废弃）
    stats: { matches: 0, winners: 0, draws: 0, flees: 0 },
    createdAt: new Date(),
    updatedAt: new Date(),
  };
}

/**
 * 资源种子：只用于首次部署灌库，之后管理端说了算（`seedAssets` 一次性标记）。
 *
 * SB-066：只有一个 `default` 包——「经典/深空/街机主题」不再作为产品概念，
 * `asset_packs` 只留一个存储分组。资源明细 `pack × game × group × key` 唯一。
 * 每条资源都属于某个游戏（`game` = slug），**没有全游戏通用层**；
 * click/win/lose 也按游戏各配一行，避免「所有游戏共用一份音效」。
 *
 * 组约定（可扩展，加一种资源只需加一行）：
 * | group | kind | key | 说明 |
 * |---|---|---|---|
 * | `bgm` | audio | `main`/`secondary` | 该游戏背景音乐 |
 * | `sfx` | audio | `click`/`move`/`collect`/`win`/`lose` | 音效，按游戏各一份 |
 * | `food` | image | `small`/`mid`/`big` | 食物三档（贪吃蛇，不可装备） |
 * | `items` | image | `magnet`/`star` | 道具（贪吃蛇，不可装备） |
 * | `snake` | image | `default`/`neon`/`candy` | 蛇皮肤：url=身体图，meta.head=蛇头图（可装备） |
 * | `corpse` | image | `default` | 死亡残骸外观（可装备） |
 */
export const SEED_ASSET_PACKS: IAssetPack[] = [
  {
    _id: 'default', name: '默认', desc: '按游戏隔离的默认资源',
    cover: '🎮', isDefault: true, requirePermission: false, status: 1,
    createdAt: SEED_TIME, updatedAt: SEED_TIME,
  },
];

const PACK_BGM = [{ key: 'main', label: '默认主题', file: 'bgm.mp3' }];
const COMMON_SFX = ['click', 'win', 'lose'];
const GAME_SFX = ['move', 'collect'];
const AUDIO_GAME_IDS = ['gomoku', 'xiangqi', 'othello', 'chess', '2048', 'tetris', 'snake'];

/** 贪吃蛇图片：皮肤一项对应身体 + 蛇头两张图，展示时只用身体缩略图 */
const SNAKE_IMAGES: { group: string; key: string; label: string; file: string; equippable?: boolean; head?: string }[] = [
  { group: 'food', key: 'small', label: '小果', file: 'food/small.svg' },
  { group: 'food', key: 'mid', label: '中果', file: 'food/mid.svg' },
  { group: 'food', key: 'big', label: '大果', file: 'food/big.svg' },
  { group: 'items', key: 'magnet', label: '磁铁', file: 'items/magnet.svg' },
  { group: 'items', key: 'star', label: '星星', file: 'items/star.svg' },
  { group: 'snake', key: 'default', label: '斜纹', file: 'snake/default-body.svg', equippable: true, head: 'snake/default-head.svg' },
  { group: 'snake', key: 'neon', label: '霓虹点', file: 'snake/neon-body.svg', equippable: true, head: 'snake/neon-head.svg' },
  { group: 'snake', key: 'candy', label: '糖果', file: 'snake/candy-body.svg', equippable: true, head: 'snake/candy-head.svg' },
  { group: 'corpse', key: 'default', label: '默认残骸', file: 'corpse/default.svg', equippable: true },
];

function seedAsset(
  pack: string,
  game: string,
  group: string,
  key: string,
  url: string,
  label: string,
  order = 0,
  free = true,
  equippable = false,
  meta: Record<string, unknown> = {},
): IAsset {
  return {
    _id: `${pack}_${game || 'common'}_${group}_${key}`,
    pack,
    game,
    group,
    key,
    label,
    kind: group === 'bgm' || group === 'sfx' ? 'audio' : 'image',
    url,
    meta,
    equippable,
    free,
    status: 1,
    order,
    createdAt: SEED_TIME,
    updatedAt: SEED_TIME,
  };
}

export const SEED_ASSETS: IAsset[] = [];
for (const game of AUDIO_GAME_IDS) {
  for (const [i, bgm] of PACK_BGM.entries()) {
    SEED_ASSETS.push(seedAsset('default', game, 'bgm', bgm.key, `/audio/default/common/${bgm.file}`, bgm.label, i));
  }
  for (const [i, key] of [...COMMON_SFX, ...GAME_SFX].entries()) {
    SEED_ASSETS.push(seedAsset('default', game, 'sfx', key, `/audio/default/${game}/${key}.mp3`, key, i));
  }
}
for (const [i, img] of SNAKE_IMAGES.entries()) {
  const body = `/skins/default/snake/${img.file}`;
  SEED_ASSETS.push(seedAsset(
    'default', 'snake', img.group, img.key, body, img.label, i, true, img.equippable === true,
    img.head ? { head: `/skins/default/snake/${img.head}`, body } : {},
  ));
}
