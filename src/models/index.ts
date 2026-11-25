import mongoose from "mongoose";
import config from '../config';
import type { IAsset, IAssetPack, IGame, IRoom, IMatch, IPlayerAsset, IUser, IPlayer } from '../types/index';

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
  variants: [{ _id: false, key: String, label: String, mode: String, board: String, desc: String, numbers: { min: Number, max: Number }, teams: [{ _id: false, name: String, size: Number }] }],
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
  players: [{ _id: String, role: String, team: String, score: Number, is_winner: Boolean }],
  movements: [mongoose.SchemaTypes.Mixed],
  createdAt: Date, // 开始时间
  updatedAt: Date, // 结束时间
  stats: mongoose.SchemaTypes.Mixed, // 
}, { collection: 'matches', versionKey: false }))

const userSchema = new mongoose.Schema<IUser>({
  _id: String,
  name: String,
  // 展示昵称：个人中心可改；缺省等于 name（读取时兜底）
  nickname: String,
  pass: String,
  avatar: String,
  email: String,
  phone: String,
  // 语音包选择/权限：权限位仅由管理端写入，对外通过虚拟字段 hasVoicePackPermission 暴露
  voice_pack: { type: String, default: 'classic' },
  voicePackPerm: { type: Boolean, default: false },
  createdAt: { type: Date, default: Date.now },
  updatedAt: { type: Date, default: Date.now },
}, { collection: 'users', versionKey: false, });

/** 虚拟字段：是否有权限使用非默认语音包（不落库，由服务端按权限位 + 配置白名单计算） */
userSchema.virtual('hasVoicePackPermission').get(function (this: IUser) {
  return this.voicePackPerm === true;
});

export const MUser = mongoose.model<IUser>('users', userSchema);

/**
 * 资源包（原 `voice_packs`）：只存包的元信息，资源明细在 `assets`。
 * 拆开是为了「一个包的多个字段都要能改/能传」——嵌套大对象改一项就整块覆盖。
 */
export const MAssetPack = mongoose.model<IAssetPack>('asset_packs', new mongoose.Schema({
  _id: String,
  name: String,
  desc: String,
  cover: String,
  isDefault: { type: Boolean, default: false },
  requirePermission: { type: Boolean, default: true },
  status: { type: Number, default: 1 },
  createdAt: { type: Date, default: Date.now },
  updatedAt: { type: Date, default: Date.now },
}, { collection: 'asset_packs', versionKey: false }));

/**
 * 一条资源：包 × 游戏 × 分组 × key 唯一。
 * `group` 用 string 而不是枚举，加一种资源（棋盘、头像框）不用改表。
 */
const assetSchema = new mongoose.Schema<IAsset>({
  _id: String,
  pack: { type: String, index: true },
  game: { type: String, index: true, default: '' },
  group: { type: String, index: true },
  key: String,
  label: String,
  kind: { type: String, enum: ['audio', 'image'], default: 'image' },
  url: String,
  meta: mongoose.SchemaTypes.Mixed,
  // 玩家级可装备外观（存 players.skin）；false = 主题资源，随包整体生效
  equippable: { type: Boolean, default: false },
  free: { type: Boolean, default: false },
  status: { type: Number, default: 1 },
  order: { type: Number, default: 0 },
  createdAt: { type: Date, default: Date.now },
  updatedAt: { type: Date, default: Date.now },
}, { collection: 'assets', versionKey: false });
// 同一包里同一游戏的同一分组 key 只能有一条，否则 manifest 取哪个图是随机的
assetSchema.index({ pack: 1, game: 1, group: 1, key: 1 }, { unique: true });
export const MAsset = mongoose.model<IAsset>('assets', assetSchema);

/**
 * 玩家持有的资源：不是所有资源都默认可用（收费皮肤、活动限定）。
 * 判定：资源 `free` → 直接可用；否则看这张表有没有 (player_id, asset_id)。
 */
const playerAssetSchema = new mongoose.Schema<IPlayerAsset>({
  player_id: { type: String, index: true },
  asset_id: { type: String, index: true },
  source: { type: String, default: 'grant' },
  createdAt: { type: Date, default: Date.now },
}, { collection: 'player_assets', versionKey: false });
playerAssetSchema.index({ player_id: 1, asset_id: 1 }, { unique: true });
export const MPlayerAsset = mongoose.model<IPlayerAsset>('player_assets', playerAssetSchema);

/** 一次性初始化标记：种子只在首次部署灌一次，之后管理端说了算（重启不回写） */
export const MMeta = mongoose.model('meta', new mongoose.Schema({
  _id: String,
  value: mongoose.SchemaTypes.Mixed,
  updatedAt: { type: Date, default: Date.now },
}, { collection: 'meta', versionKey: false }));

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
  // 人机难度（easy/normal/hard/master，空 = 普通）：只对人机生效，开局时随 /add-robot 下发给 robot 服务
  difficulty: String,
  // 玩家装备的蛇皮肤（`assets._id`，group=snake）：玩家级属性，按游戏天然隔离；
  // 对局快照与 match.players 都引用这个 id，图由 manifest 预加载
  skin: String,
  createdAt: { type: Date, default: Date.now },
  updatedAt: { type: Date, default: Date.now },
}, { collection: 'players', versionKey: false }))

export default {
  MUser,
  MGame,
  MRoom,
  MMatch,
  MPlayer,
  MAsset,
  MAssetPack,
  MPlayerAsset,
  MMeta,
}