import mongoose from "mongoose";
import config from '../config';
import type { IGame, IRoom, IMatch, IUser, IPlayer } from '../types/index';

mongoose.set('strictQuery', true);
mongoose.connect(config.mongo_url).catch(err => {
  console.log(err)
});

export const MGame = mongoose.model<IGame>('games', new mongoose.Schema({
  _id: String,
  slug: String,
  title: String,
  desc: String,
  genre: String,
  icon: String,
  status: Number,
  // solo=单人直接开局（无房间）；room=房间制（棋类/组队）
  mode: { type: String, default: 'room' },
  // 玩法变体：同一游戏可同时提供单人玩法与房间玩法（贪吃蛇：无尽/多人）
  variants: [{ _id: false, key: String, label: String, mode: String, board: String, desc: String, numbers: { min: Number, max: Number } }],
  // 排行榜分榜：每个玩法一张榜
  boards: [{ _id: false, key: String, label: String }],
  numbers: { min: Number, max: Number },
  role_config: {
    mode: String, // fixed/team/custom
    roles: [{ name: String, size: Number }]
  },
  createdAt: { type: Date, default: Date.now },
  updatedAt: { type: Date, default: Date.now },
}, { collection: 'games', versionKey: false, }));

export const MRoom = mongoose.model<IRoom>('rooms', new mongoose.Schema({
  _id: String,
  game_id: String,
  name: String,
  status: String,
  owner_id: String,
  match_id: String,
  members: [{
    _id: String,
    role: String,
    team: String,
    player_type: { type: String },
    member_type: { type: String },
  }],
  seats: [{ _id: false, team: String, size: Number }],
  numbers: { min: Number, max: Number },
  isPrivate: Boolean,
  password: String,
  // 官方公共房（种子预建，不可解散，只能退出）
  official: { type: Boolean, default: false },
  // 是否允许观战（房主开局前可切换）
  allowSpectate: { type: Boolean, default: true },
  // 单人快开临时房：不进列表/计数，离开即销毁
  transient: { type: Boolean, default: false },
  startedAt: Date,
  createdAt: { type: Date, default: Date.now },
  updatedAt: { type: Date, default: Date.now },
  settings: mongoose.SchemaTypes.Mixed,
}, { collection: 'rooms', versionKey: false, }));

export const MMatch = mongoose.model<IMatch>('matches', new mongoose.Schema({
  _id: String,
  game_id: String,
  room_id: String,
  status: String,
  init_state: mongoose.SchemaTypes.Mixed,
  curr_state: mongoose.SchemaTypes.Mixed,
  players: [{ _id: String, role: String, score: Number, is_winner: Boolean }],
  movements: [mongoose.SchemaTypes.Mixed],
  createdAt: Date, // 开始时间
  updatedAt: Date, // 结束时间
  stats: mongoose.SchemaTypes.Mixed, // 
}, { collection: 'matches', versionKey: false }))

export const MUser = mongoose.model<IUser>('users', new mongoose.Schema({
  _id: String,
  name: String,
  pass: String,
  avatar: String,
  email: String,
  phone: String,
  createdAt: { type: Date, default: Date.now },
  updatedAt: { type: Date, default: Date.now },
}, { collection: 'users', versionKey: false, }));

export const MPlayer = mongoose.model<IPlayer & { room_id: string }>('players', new mongoose.Schema({
  _id: String,
  game_id: String,
  room_id: String,
  user_id: String,
  nickname: String,
  avatar: String,
  title: String,
  type: { type: String }, // player robot
  level: { type: Number, default: 1 },
  score: { type: Number, default: 0 },
  // 分榜最高分：{ [boardKey]: score }
  boards: mongoose.SchemaTypes.Mixed,
  exp: { type: Number, default: 0 },
  status: Number,
  state: String,
  atline: Boolean,
  stats: mongoose.SchemaTypes.Mixed,
  createdAt: { type: Date, default: Date.now },
  updatedAt: { type: Date, default: Date.now },
}, { collection: 'players', versionKey: false }))

export default {
  MUser,
  MGame,
  MRoom,
  MMatch,
  MPlayer,
}