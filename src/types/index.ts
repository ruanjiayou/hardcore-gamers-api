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
  room_id: string;
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
  name: string;
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

/** 单个游戏在一套语音包里的音频配置；未配置的键回退到包级通用配置 */
export interface IGameAudio {
  bgm?: { url: string; label?: string }[];
  sfx?: Record<string, string>;
}

/** 语音包：一份配置引用若干音频文件 URL，由前端按 URL 加载播放 */
export interface IVoicePack {
  _id: string;
  name: string;
  desc: string;
  cover?: string;
  /** 默认包：所有玩家（含游客）都可用 */
  isDefault: boolean;
  /** 需要权限：无权限玩家只能用默认包 */
  requirePermission: boolean;
  /** 包级通用背景音乐（游戏未单独配置时使用），可多首循环播放 */
  bgm: { url: string; label?: string }[];
  /** 包级通用音效：click/win/lose 等；游戏未单独配置时使用 */
  sfx: Record<string, string>;
  /** 按游戏区分的音频：key 为 game_id / slug，例如 gomoku、xiangqi、2048 */
  games?: Record<string, IGameAudio>;
  status: number; // 1 启用
  createdAt: Date;
  updatedAt: Date;
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