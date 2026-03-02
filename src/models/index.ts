import mongoose from "mongoose";
import config from '../config';
import type { IGame, IRoom, IUser, IPlayer } from '../types/index';

mongoose.set('strictQuery', true);
mongoose.connect(config.mongo_url).catch(err => {
  console.log(err)
});

export const MGame = mongoose.model<IGame>('games', new mongoose.Schema({
  _id: String,
  name: String,
  desc: String,
  genre: String,
  icon: String,
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
  gameId: String,
  name: String,
  status: String,
  owner_id: String,
  members: [{
    _id: String,
    user_name: String,
    title: String,
    status: Number,
    state: String,
    level: Number,
    score: Number,
    user_id: String,
    avatar: String,
    role: String,
    team: String,
    type: String,
  }],
  seats: [{ _id: false, team: String, size: Number }],
  numbers: { min: Number, max: Number },
  isPrivate: Boolean,
  password: String,
  startedAt: Date,
  createdAt: { type: Date, default: Date.now },
  updatedAt: { type: Date, default: Date.now },
  settings: mongoose.SchemaTypes.Mixed,
}, { collection: 'rooms', versionKey: false, }));

export const MMatch = mongoose.model('matches', new mongoose.Schema({
  _id: String,
  game_id: String,
  room_id: String,
  status: String,
  state: mongoose.SchemaTypes.Mixed,
  players: [{ _id: String, role: String, score: Number, is_winner: Boolean }],
  movements: [{ _id: false, player_id: String, data: mongoose.SchemaTypes.Mixed, timestamp: Number, }],
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

export const MPlayer = mongoose.model<IPlayer>('players', new mongoose.Schema({
  _id: String,
  game_id: String,
  room_id: String,
  user_id: String,
  user_name: String,
  avatar: String,
  title: String,
  level: { type: Number, default: 1 },
  score: { type: Number, default: 0 },
  exp: { type: Number, default: 0 },
  status: Number,
  online: Boolean,
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