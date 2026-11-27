import { RoomStatus, GameGenre, MatchStatus, PlayerState, PlayerType, MemberType } from "../constant";

export type CB = Function;
/**
 * 游戏大厅系统的类型定义
 */

export interface IRoleConfig {
  mode: 'fixed' | 'team' | 'custom',
  roles: { name: string; size: number }[]
}
// ========== 游戏相关 ==========

/** 分榜定义：同一游戏内不同玩法各自一张排行榜（如贪吃蛇的无尽榜/多人榜） */
export interface IGameBoard {
  key: string;
  label: string;
}

/** 玩法变体：一个游戏可以同时提供单人玩法与房间玩法（如贪吃蛇的无尽/多人） */
export interface IGameVariant {
  key: string;
  label: string;
  mode: 'solo' | 'room';
  /** 该玩法的排行榜 key；缺省用 variant.key */
  board?: string;
  desc?: string;
  /** 该玩法的人数限制（缺省用 game.numbers） */
  numbers?: { min: number, max: number };
  /** 该玩法的队伍配置（团队模式：6 队 × 每队 5 人） */
  teams?: { name: string; size: number }[];
  /**
   * **常驻竞技场**玩法：官方桌常驻 playing，玩家随时进出，房间只当内部容器
   * （成员表 + socket 频道），对外只呈现「一场对局 + 榜单」。
   *
   * 属于**玩法结构**决策（与 `teams` 同级），不由管理端后台覆盖。
   */
  arena?: boolean;
}

export interface IGame {
  _id: string;
  slug: string;
  title: string;
  desc: string;
  numbers: { min: number, max: number };
  /** 游戏主页形态：solo=单人直接开局（无需房间）；room=房间制（棋类/组队） */
  mode: 'solo' | 'room';
  genre: GameGenre;
  icon: string;
  status: number;
  createdAt: Date;
  updatedAt: Date;
  role_config: object;
  /** 玩法可调参数（手感配置），各游戏字段自定义、互不干扰 */
  config?: Record<string, any>;
  /** 玩法变体（单人/房间混合的游戏才需要），缺省按 mode 单一形态 */
  variants?: IGameVariant[];
  /** 排行榜分榜（缺省只有一张总榜，读 MPlayer.score） */
  boards?: IGameBoard[];
  rooms?: number;
  players?: number;
}

// ========== 房间相关 ==========

// 更新 Room 接口
export interface IRoom {
  _id: string;
  name: string;
  game_id: string;
  owner_id: string;
  match_id?: string;
  status: RoomStatus;
  members: IMember[];
  seats: ISeat[],
  numbers: { min: number, max: number };
  isPrivate: boolean;
  password?: string;  // 新增：房间密码
  /** 官方公共房（种子预建）：任何人只能退出，不可解散 */
  official?: boolean;
  /** 是否允许观战（房主可在开局前切换） */
  allowSpectate?: boolean;
  /** 单人快开的临时房：不进房间列表/计数，离开即销毁 */
  transient?: boolean;
  createdAt: Date;
  updatedAt: Date;
  startedAt?: Date;
  settings: Record<string, any>;
}

export interface IMatch {
  _id: string;
  /** 首房（主房）：单房对局就是它；团队合局时取 room_ids[0]，保留兼容 */
  room_id: string;
  /** 团队合局关联的全部房间 id（单房对局为空）；SB-064 */
  room_ids?: string[];
  game_id: string;
  status: MatchStatus;
  init_state: any;
  curr_state: any;
  players: IMember[];
  movements: any[];
  createdAt: Date;
  updatedAt: Date;
  stats: {
    winner_id: string;
  };
}

export interface IUser {
  _id: string;
  /** 登录名（唯一性由应用层保证，不可改） */
  name: string;
  /** 展示昵称：个人中心可改，缺省等于 name */
  nickname?: string;
  avatar: string;
  pass: string;
  email: string;
  phone: string;
  /** 已选语音包 id（缺省 classic） */
  voice_pack?: string;
  /** 是否可使用需要权限的语音包；管理端置位，服务端再算成虚拟字段下发 */
  voicePackPerm?: boolean;
  createdAt: Date;
  updatedAt: Date;
}

/**
 * 资源系统（`assets` 一行一条，`asset_packs` 是分组容器）。
 *
 * 为什么不是「一个包一个大对象」：不同类型的资源字段根本不同——
 * 背景音乐要循环/时长，音效要 key（move/collect/click），
 * 食物按档位（small/mid/big），道具按注册表 key，蛇皮肤还带画风/尺寸。
 * 塞进一个 Mixed 里就只能靠约定，改一处全得动。拆成行之后：
 * - 加一种资源 = 加一行（`group` 自定义），不用改表结构；
 * - 改一张图 = 改一行，不会覆盖同包其他资源；
 * - 权限/上下架是行级字段，能单独控制。
 */
export type AssetKind = 'audio' | 'image';
/**
 * 内置分组（`group` 是 string，这里只列约定好的，允许扩展 board/avatar 等）。
 *
 * 分组名由**游戏自己定**：服务端不解释 `snake` / `board` 的含义，只按名字分组下发，
 * 所以黑白棋配一个 `board` 分组不会牵扯到贪吃蛇的 `snake` 分组。
 */
export type AssetGroup = 'bgm' | 'sfx' | 'food' | 'items' | 'snake';

/** 一条资源：资源包 × 游戏 × 分组 × key 唯一 */
export interface IAsset {
  _id: string;
  /** 所属资源包（`asset_packs._id`） */
  pack: string;
  /** 所属游戏 slug；`''` 表示全游戏通用（只有 UI 通用音 click/win/lose 这类） */
  game: string;
  /** 分组：bgm / sfx / food / items / snake / 以后任意扩展 */
  group: string;
  /** 组内唯一 key：move、small、magnet、neon…… */
  key: string;
  label: string;
  kind: AssetKind;
  url: string;
  /** 组专属字段：音频时长/循环、皮肤色调与尺寸等，不参与查询 */
  meta?: Record<string, unknown>;
  /**
   * 玩家级可装备外观：true = 玩家能在设置里选它并装备（存 `players.skin`）；
   * false = 主题资源，随资源包整体生效（食物、道具、棋盘……），玩家不能单独换。
   *
   * 这个标记是**数据**不是代码：服务端不再硬编码「哪个 group 才是皮肤」，
   * 任何游戏想加玩家级外观，后台勾一下即可，不用改服务端。
   */
  equippable: boolean;
  /** 免授权：默认包资源与基础资源，所有玩家可用 */
  free: boolean;
  status: number; // 1 上架 0 下架
  order: number;
  createdAt: Date;
  updatedAt: Date;
}

/** 资源包元信息：只描述包本身，资源明细在 `assets` */
export interface IAssetPack {
  _id: string;
  name: string;
  desc: string;
  cover?: string;
  /** 默认包：所有玩家（含游客）都可用 */
  isDefault: boolean;
  /** 需要权限：无权限玩家只能用默认包 */
  requirePermission: boolean;
  status: number; // 1 启用 0 下架
  createdAt: Date;
  updatedAt: Date;
}

/**
 * 玩家持有的资源（授权关联）。
 * 不是所有资源都默认对玩家开放：收费皮肤、活动限定等要先「授予」。
 * 判定顺序：资源 `free` → 直接可用；否则看本表有没有 (player_id, asset_id) 记录。
 */
/**
 * 好友关系（`SB-060`）：主体是**玩家**不是用户，所以按游戏天然隔离。
 * 一条关系一行，`_id` 用字典序规范化后的 `player_a:player_b` —— 接受申请时 upsert，天然幂等。
 */
export interface IFriend {
  _id: string;
  player_a: string;
  player_b: string;
  createdAt: Date;
}

export interface IPlayerAsset {
  player_id: string;
  asset_id: string;
  /** free：随免费资源自动写入；grant：后台手动授予 */
  source: 'free' | 'grant';
  createdAt: Date;
}
/**
 * 房间座位块（rooms.seats）。
 * 团队模式（贪吃蛇）用它声明"有哪些队伍、每队几个位置"：
 * [{ team: '红队', size: 5 }, ...]。
 * role / user_id 保留给未来的固定角色座位（如棋类红/黑方）。
 */
export interface ISeat {
  team: string;
  /** 该座位块的容量（团队模式：每队人数上限） */
  size?: number;
  role?: string;
  user_id?: string;
}
// ========== 玩家相关 ==========
export interface IPlayer {
  _id: string;
  type: string; // player robot
  user_id: string;
  game_id: string;
  nickname: string;
  avatar: string;

  title: string; // 称号
  level: number; // 等级
  score: number; // 分数
  /** 分榜最高分：{ [boardKey]: score }，排行榜按玩法分别展示 */
  boards?: Record<string, number>;
  exp: number; // 经验值
  max_level: number;
  stats: PlayerStats;
  atline: boolean;
  status: number; // 1 normal 2 muted 3 banned
  state: string;
  /** 人机难度（easy/normal/hard/master）；空视为 normal，只对人机生效 */
  difficulty?: string;
  /** 玩家装备的蛇皮肤（`assets._id`，group=snake）；空 = 用默认皮肤 */
  skin?: string;
  /** 玩家装备的死亡残骸外观（`assets._id`，group=corpse）；空 = 用默认残骸 */
  corpse_skin?: string;
  createdAt: Date;
  updatedAt: Date;
}
export interface IMember {
  _id: string;
  player_type: PlayerType;
  member_type: MemberType;
  role?: string; // 角色
  team?: string; // 队伍
}

export interface PlayerStats {
  matches: number;
  winners: number;
  draws: number;
  flees: number;
}

// ========== 匹配相关 ==========
export type MatchingMode = 'ranked' | 'casual' | 'team';

export interface MatchingRequest {
  player_id: string;
  game_id: string;
  mode: MatchingMode;
  minimumLevel?: number;
  maximumRating?: number;
  createdAt: number;
}

// ========== 事件相关 ==========
export interface SocketWithAuth {
  id: string;
  data: any;
  emit: (event: string, data?: any) => void;
  on: (event: string, callback: (data?: any) => void) => void;
  join: (room: string) => void;
  leave: (room: string) => void;
  disconnect: () => void;
}

// ========== 响应相关 ==========
export interface ApiResponse<T = any> {
  code: number;
  message: string;
  data?: T;
  timestamp: number;
}

export interface Error {
  code: string;
  message: string;
}