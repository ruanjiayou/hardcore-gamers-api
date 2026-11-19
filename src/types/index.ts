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
  createdAt: Date;
  updatedAt: Date;
}
export interface ISeat {
  role: string;
  team: string;
  user_id: string;
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