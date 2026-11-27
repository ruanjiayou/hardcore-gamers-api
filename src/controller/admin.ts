/**
 * 管理端 HTTP 接口（挂载在 /api/admin）。
 *
 * 鉴权：单密码换 JWT。密码取 etcd 配置里的 `admin_pass`，其次环境变量 ADMIN_PASS；
 * 两者都没有时**拒绝登录**（不设默认密码，避免留后门）。
 *
 * 覆盖范围：游戏增删改查 / 人机池 / 房间与房内人机 / 概览与自愈。
 * 复用既有 service（roomService.destroyRoom、kickPlayer、reconcileRoom、addRobotToRoom），
 * 不重写业务规则——管理端只是这些能力的另一个入口。
 */
import { Router, raw as rawBody } from 'express';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import jwt from 'jsonwebtoken';
import { v7 } from 'uuid';
import config from '../config';
import constant, { isRobotDifficulty } from '../constant';
import { MAsset, MAssetPack, MGame, MMatch, MPlayer, MPlayerAsset, MRoom, MUser } from '../models';
import { addRobotToRoom } from '../services/RobotService';
import { invalidatePackCache } from '../services/VoicePackService';
import { assetsService, kindOfGroup, listPacks, purgePack, DEFAULT_PACK_ID } from '../services/AssetsService';
import { roomService } from '../services/RoomService';
import { getGameParamSchema } from '../services/GameParamsService';
import { getGameDefaultParams, isGameParamsDefault, normalizeGameParams } from '../games/paramsRegistry';
import GameLogics from '../games';

const router = Router();
const { ROOM, PLAYER, MATCH } = constant;

const adminPass = () => config.admin_pass || process.env.ADMIN_PASS || '';
const md5 = (s: string) => crypto.createHash('md5').update(s).digest('hex');
/** 定长哈希后比较，避免密码长度/前缀泄露 */
const samePass = (a: string, b: string) =>
  crypto.timingSafeEqual(
    crypto.createHash('sha256').update(a).digest(),
    crypto.createHash('sha256').update(b).digest(),
  );

router.post('/login', (req, res) => {
  const pass = adminPass();
  if (!pass) {
    res.json({ code: -1, message: '未配置管理密码：请在 etcd 的 games-api 配置里加 "admin_pass"' });
    return;
  }
  if (!samePass(String(req.body?.pass || ''), pass)) {
    res.json({ code: -1, message: '密码错误' });
    return;
  }
  const token = jwt.sign({ role: 'admin' }, config.secret, { expiresIn: '12h' });
  res.json({ code: 0, data: { token } });
});

router.use((req, res, next) => {
  const token = String(req.headers.authorization || '').replace(/^Bearer /, '');
  try {
    const data: any = jwt.verify(token, config.secret);
    if (data?.role !== 'admin') throw new Error('role');
    next();
  } catch {
    res.status(401).json({ code: 401, message: '登录已过期，请重新登录' });
  }
});

/** 统一包一层：service 抛错不要把 500 吐给前端 */
const wrap = (fn: (req: any, res: any) => Promise<void>) => async (req: any, res: any) => {
  try {
    await fn(req, res);
  } catch (err: any) {
    console.error('[admin]', err);
    res.json({ code: -1, message: err?.message || '操作失败' });
  }
};

/** 房间成员的真名/类型要从 players 里补，不然管理端只能看到一串 _id */
async function withMemberDetail(rooms: any[]) {
  const ids = [...new Set(rooms.flatMap(r => (r.members || []).map((m: any) => m._id)))];
  const players = ids.length
    ? await MPlayer.find({ _id: { $in: ids } }, { nickname: 1, type: 1, avatar: 1, state: 1 }).lean(true)
    : [];
  const byId = new Map(players.map(p => [p._id, p]));
  return rooms.map(r => ({
    ...r,
    members: (r.members || []).map((m: any) => ({
      ...m,
      nickname: byId.get(m._id)?.nickname || '(已不存在)',
      state: byId.get(m._id)?.state || '',
      missing: !byId.has(m._id),
    })),
  }));
}

// ========== 概览 ==========

router.get('/overview', wrap(async (_req, res) => {
  const [games, roomRows, robotRows, online, matches] = await Promise.all([
    MGame.countDocuments(),
    MRoom.aggregate([
      { $match: { status: { $ne: ROOM.STATUS.deleted }, transient: { $ne: true } } },
      { $group: { _id: '$status', n: { $sum: 1 } } },
    ]),
    MPlayer.aggregate([
      { $match: { type: PLAYER.TYPE.robot } },
      { $group: { _id: '$state', n: { $sum: 1 } } },
    ]),
    MPlayer.countDocuments({ type: PLAYER.TYPE.player, atline: true }),
    MMatch.countDocuments({ status: MATCH.STATUS.playing }),
  ]);
  res.json({
    code: 0,
    data: {
      games,
      rooms: Object.fromEntries(roomRows.map(r => [r._id || 'unknown', r.n])),
      robots: Object.fromEntries(robotRows.map(r => [r._id || 'unknown', r.n])),
      online_players: online,
      playing_matches: matches,
      admin_pass_configured: Boolean(adminPass()),
    },
  });
}));

// ========== 游戏增删改查 ==========

router.get('/games', wrap(async (_req, res) => {
  const games = await MGame.find().lean(true);
  const stats = await MRoom.aggregate([
    { $match: { status: { $ne: ROOM.STATUS.deleted }, transient: { $ne: true } } },
    { $group: { _id: '$game_id', rooms: { $sum: 1 } } },
  ]);
  const byGame = new Map(stats.map(s => [s._id, s.rooms]));
  res.json({
    code: 0,
    data: games.map(g => ({
      ...g,
      rooms: byGame.get(g._id) || 0,
      // 代码是否已注册：没注册的游戏能建也能上架，但一开局就 500，管理端要先看得见
      code_registered: Boolean(GameLogics[g.slug]),
      // 玩法参数（手感配置）：默认值得服务端下发，前端不自己维护字段清单
      default_config: getGameDefaultParams(g.slug),
      // 存的值是否已经偏离默认值（管理端列表显示「已自定义」标记）
      config_overridden: !isGameParamsDefault(g.slug, (g as any).config),
    })),
  });
}));

/**
 * 某个游戏的可配置参数说明（标签 / 区间 / 单位 / 默认值 / 当前生效值）。
 *
 * 前端据此渲染表单 —— 加参数只改服务端的参数表，管理端自动多出一项。
 */
router.get('/params/:slug', wrap(async (req, res) => {
  const schema = await getGameParamSchema(req.params.slug);
  if (!schema) {
    res.json({ code: 0, data: null });
    return;
  }
  res.json({ code: 0, data: { slug: req.params.slug, params: schema } });
}));

const GAME_WRITABLE = ['slug', 'title', 'desc', 'genre', 'icon', 'status', 'mode', 'numbers', 'variants', 'boards', 'role_config', 'config'];

router.post('/games', wrap(async (req, res) => {
  const body = req.body || {};
  const slug = String(body.slug || '').trim();
  if (!/^[a-z0-9-]+$/.test(slug)) throw new Error('slug 只能是小写字母、数字与中划线');
  if (await MGame.findOne({ slug }).lean(true)) throw new Error('slug 已存在');
  const game: any = { _id: v7(), status: 1, mode: 'room', numbers: { min: 2, max: 2 } };
  for (const k of GAME_WRITABLE) if (body[k] !== undefined) game[k] = body[k];
  game.slug = slug;
  game.title = game.title || slug;
  // 玩法参数：按该游戏自己的解析器校验裁剪后再存（存解析后的完整值）
  if (game.config !== undefined) game.config = normalizeGameParams(slug, game.config ?? {});
  game.createdAt = game.updatedAt = new Date();
  await MGame.create(game);
  res.json({ code: 0, data: game, message: GameLogics[slug] ? '已创建' : '已创建，但该 slug 尚无服务端逻辑，开局会失败' });
}));

router.put('/games/:id', wrap(async (req, res) => {
  const patch: any = { updatedAt: new Date() };
  for (const k of GAME_WRITABLE) if (req.body?.[k] !== undefined) patch[k] = req.body[k];
  // 玩法参数（config）：按该游戏自己的解析器校验裁剪后再存。
  // 存的是解析后的完整值 —— 数据库自解释，代码改默认值不会悄悄改掉运营调过的游戏。
  // 传 null 表示「清除自定义，回到代码默认值」。
  if (patch.config !== undefined) {
    const game = await MGame.findById(req.params.id, { slug: 1 }).lean(true) as any;
    if (!game) throw new Error('游戏不存在');
    patch.config = normalizeGameParams(game.slug, patch.config ?? {});
  }
  // 结构性字段（mode/variants/boards/numbers）现在由管理端权威：
  // seedGames() 已改为「已存在则完全不碰」，重启不会回写（SB-052）
  const structural = ['mode', 'variants', 'boards', 'numbers'].some(k => patch[k] !== undefined);
  await MGame.updateOne({ _id: req.params.id }, { $set: patch });
  res.json({
    code: 0,
    message: patch.config !== undefined
      ? '已保存；新参数从下一局开始生效，进行中的对局保持原参数'
      : structural ? '已保存；结构化字段以后台为准，服务重启不会被种子回写' : '已保存',
  });
}));

router.delete('/games/:id', wrap(async (req, res) => {
  const game = await MGame.findById(req.params.id).lean(true);
  if (!game) throw new Error('游戏不存在');
  const rooms = await MRoom.countDocuments({ game_id: game._id, status: { $ne: ROOM.STATUS.deleted } });
  if (rooms > 0) throw new Error(`还有 ${rooms} 个房间，先解散或删除房间再删游戏`);
  await MGame.deleteOne({ _id: game._id });
  res.json({ code: 0, message: '已删除' });
}));

// ========== 人机池 ==========

router.get('/robots', wrap(async (req, res) => {
  const query: any = { type: PLAYER.TYPE.robot };
  if (req.query.game_id) query.game_id = String(req.query.game_id);
  const robots = await MPlayer.find(query).lean(true);
  const rooms = await MRoom.find({ _id: { $in: robots.map(r => r.room_id).filter(Boolean) } }, { name: 1 }).lean(true);
  const roomName = new Map(rooms.map(r => [r._id, r.name]));
  res.json({
    code: 0,
    data: robots.map((r: any) => ({ ...r, room_name: r.room_id ? roomName.get(r.room_id) || r.room_id : '' })),
  });
}));

router.post('/robots', wrap(async (req, res) => {
  const { game_id, nickname, level, difficulty } = req.body || {};
  const game = await MGame.findById(String(game_id || '')).lean(true);
  if (!game) throw new Error('游戏不存在');
  if (difficulty !== undefined && !isRobotDifficulty(difficulty)) throw new Error('难度只能是 easy/normal/hard/master');
  const suffix = v7().slice(0, 8);
  const player_id = `robot-player-${game.slug}-${suffix}`;
  const user_id = `robot-user-${game.slug}-${suffix}`;
  await MUser.create({
    _id: user_id,
    // 昵称不带 🤖 前缀（UI-054）：机器人身份由玩家列表的「机」徽标体现
    name: nickname || '人机',
    pass: md5(v7()),
    createdAt: new Date(),
  });
  await MPlayer.create({
    _id: player_id,
    user_id,
    game_id: game._id,
    room_id: '',
    nickname: nickname || '人机',
    type: PLAYER.TYPE.robot,
    state: PLAYER.STATE.online,
    level: Number(level) || 1,
    difficulty: isRobotDifficulty(difficulty) ? difficulty : PLAYER.DEFAULT_DIFFICULTY,
    score: 0,
    createdAt: new Date(),
  });
  res.json({ code: 0, data: { _id: player_id } });
}));

router.put('/robots/:id', wrap(async (req, res) => {
  const patch: any = { updatedAt: new Date() };
  if (req.body?.nickname !== undefined) patch.nickname = String(req.body.nickname);
  if (req.body?.level !== undefined) patch.level = Number(req.body.level) || 1;
  if (req.body?.state !== undefined) patch.state = String(req.body.state);
  if (req.body?.difficulty !== undefined) {
    if (!isRobotDifficulty(req.body.difficulty)) throw new Error('难度只能是 easy/normal/hard/master');
    patch.difficulty = req.body.difficulty;
  }
  await MPlayer.updateOne({ _id: req.params.id, type: PLAYER.TYPE.robot }, { $set: patch });
  res.json({ code: 0 });
}));

/** 把卡在 matching / 房间里的人机放回空闲池（重启或异常退出后最常见的脏状态） */
router.post('/robots/:id/release', wrap(async (req, res) => {
  await MPlayer.updateOne(
    { _id: req.params.id, type: PLAYER.TYPE.robot },
    { $set: { state: PLAYER.STATE.online, room_id: '', updatedAt: new Date() } },
  );
  res.json({ code: 0, message: '已放回空闲池（若它还在房间里，房间内仍会显示，需要从房间踢出）' });
}));

router.delete('/robots/:id', wrap(async (req, res) => {
  const robot = await MPlayer.findById(req.params.id).lean(true) as any;
  if (!robot || robot.type !== PLAYER.TYPE.robot) throw new Error('人机不存在');
  if (robot.room_id) throw new Error('该人机正在房间里，先从房间踢出再删除');
  await MPlayer.deleteOne({ _id: robot._id });
  const stillUsed = await MPlayer.countDocuments({ user_id: robot.user_id });
  if (!stillUsed) await MUser.deleteOne({ _id: robot.user_id });
  res.json({ code: 0, message: '已删除' });
}));

// ========== 资源：包 / 资源明细 / 上传 / 玩家授权 ==========
//
// 数据模型：`asset_packs`（包）+ `assets`（一行一条资源）+ `player_assets`（授权）。
// 后台不再「编辑一个包的嵌套对象」——那样改一个字段就得整块覆盖，也没法单独上下架/授权。

const SLUG_RE = /^[a-z0-9_-]{1,32}$/;
/** 上传白名单：只认这些扩展名，其余一律拒绝（不信任客户端 MIME） */
const UPLOAD_EXT = new Set(['svg', 'png', 'webp', 'jpg', 'jpeg', 'gif', 'mp3', 'ogg', 'wav', 'm4a']);

function assertSlug(value: unknown, field: string): string {
  const s = String(value ?? '');
  if (!SLUG_RE.test(s)) throw new Error(`${field} 只能是小写字母/数字/下划线/中划线`);
  return s;
}

/** 资源地址：允许站内相对路径或 http(s) */
function assertUrl(value: unknown): string {
  const url = String(value ?? '').trim();
  if (!url) throw new Error('资源地址不能为空');
  if (!/^\/[^\s]*$/.test(url) && !/^https?:\/\//i.test(url)) {
    throw new Error('资源地址必须是 / 开头的站内路径或 http(s) 链接');
  }
  return url;
}

/** 包列表 */
router.get('/packs', wrap(async (_req, res) => {
  res.json({ code: 0, data: await listPacks() });
}));

/** 新建包；`_id` 可指定（用于 /skins/<pack>/... 目录名），不指定则自动生成 */
router.post('/packs', wrap(async (req, res) => {
  const { id, name, desc, cover, isDefault, requirePermission } = req.body || {};
  if (!name || !String(name).trim()) throw new Error('包名不能为空');
  const _id = id ? assertSlug(id, '包 id') : v7().slice(0, 8);
  if (await MAssetPack.findById(_id).lean(true)) throw new Error(`包 id「${_id}」已存在`);
  const now = new Date();
  const makeDefault = isDefault === true;
  if (makeDefault) await MAssetPack.updateMany({}, { $set: { isDefault: false } });
  await MAssetPack.create({
    _id,
    name: String(name).trim(),
    desc: String(desc || ''),
    cover: String(cover || ''),
    isDefault: makeDefault,
    requirePermission: requirePermission !== false,
    status: 1,
    createdAt: now,
    updatedAt: now,
  });
  await invalidatePackCache();
  res.json({ code: 0, data: { _id }, message: '已创建' });
}));

/** 改包元信息（不含资源明细） */
router.put('/packs/:id', wrap(async (req, res) => {
  const pack = await MAssetPack.findById(req.params.id).lean(true);
  if (!pack) throw new Error('资源包不存在');
  const patch: Record<string, any> = { updatedAt: new Date() };
  const body = req.body || {};
  if (body.name !== undefined) patch.name = String(body.name).trim();
  if (body.desc !== undefined) patch.desc = String(body.desc);
  if (body.cover !== undefined) patch.cover = String(body.cover);
  if (body.requirePermission !== undefined) patch.requirePermission = body.requirePermission !== false;
  if (body.status !== undefined) patch.status = Number(body.status) ? 1 : 0;
  if (body.isDefault === true) {
    // 默认包是唯一回退目标，只能有一个
    await MAssetPack.updateMany({ _id: { $ne: req.params.id } }, { $set: { isDefault: false } });
    patch.isDefault = true;
  } else if (body.isDefault === false) {
    if (pack.isDefault) throw new Error('至少要保留一个默认包');
    patch.isDefault = false;
  }
  await MAssetPack.updateOne({ _id: req.params.id }, { $set: patch });
  await invalidatePackCache();
  res.json({ code: 0, message: '已保存' });
}));

/** 删包：连带清资源与授权（默认包禁止删除） */
router.delete('/packs/:id', wrap(async (req, res) => {
  const pack = await MAssetPack.findById(req.params.id).lean(true) as any;
  if (!pack) throw new Error('资源包不存在');
  if (pack.isDefault) throw new Error('默认包不能删除，先把别的包设为默认');
  await purgePack(req.params.id);
  await invalidatePackCache();
  res.json({ code: 0, message: '已删除（含包内资源与授权）' });
}));

/** 资源明细列表：按包/游戏/分组过滤，不传就全量 */
router.get('/assets', wrap(async (req, res) => {
  const query: Record<string, any> = {};
  if (req.query.pack) query.pack = String(req.query.pack);
  if (req.query.game !== undefined) query.game = String(req.query.game);
  if (req.query.group) query.group = String(req.query.group);
  const rows = await MAsset.find(query).sort({ pack: 1, game: 1, group: 1, order: 1, key: 1 }).lean(true);
  res.json({ code: 0, data: rows });
}));

/** 校验并规范化一条资源（新建与修改共用） */
function normalizeAsset(body: any, existing?: any) {
  // 后台不再暴露主题包选择器：新建资源写默认包（SB-066 / ADMIN-013）
  const pack = body.pack !== undefined ? assertSlug(body.pack, 'pack') : (existing?.pack ?? DEFAULT_PACK_ID);
  if (!pack) throw new Error('缺少 pack');
  const game = body.game !== undefined ? String(body.game).trim() : (existing?.game || '');
  if (game && !SLUG_RE.test(game)) throw new Error('game 不合法');
  const group = body.group !== undefined ? assertSlug(body.group, 'group') : existing?.group;
  if (!group) throw new Error('缺少 group');
  const key = body.key !== undefined ? assertSlug(body.key, 'key') : existing?.key;
  if (!key) throw new Error('缺少 key');
  const kind = body.kind !== undefined ? String(body.kind) : (existing?.kind || kindOfGroup(group));
  if (kind !== 'audio' && kind !== 'image') throw new Error('kind 只能是 audio 或 image');
  const url = body.url !== undefined ? assertUrl(body.url) : existing?.url;
  if (!url) throw new Error('缺少 url');
  return {
    pack,
    game,
    group,
    key,
    label: body.label !== undefined ? String(body.label) : (existing?.label || key),
    kind,
    url,
    meta: body.meta !== undefined ? body.meta : (existing?.meta || {}),
    // 玩家级可装备外观：勾了才能在设置里装备（存 players.skin）
    equippable: body.equippable !== undefined ? body.equippable === true : (existing?.equippable === true),
    free: body.free !== undefined ? body.free === true : (existing?.free === true),
    status: body.status !== undefined ? (Number(body.status) ? 1 : 0) : (existing?.status ?? 1),
    order: body.order !== undefined ? Number(body.order) || 0 : (existing?.order ?? 0),
  };
}

/** 同一个包×游戏×分组下 key 不能重复，否则 manifest 取哪个是随机的 */
async function assertAssetUnique(row: { pack: string; game: string; group: string; key: string }, selfId?: string) {
  const dup = await MAsset.findOne({
    pack: row.pack, game: row.game, group: row.group, key: row.key,
    ...(selfId ? { _id: { $ne: selfId } } : {}),
  }, { _id: 1 }).lean(true);
  if (dup) throw new Error(`「${row.group}.${row.key}」在该包该游戏下已存在`);
}

router.post('/assets', wrap(async (req, res) => {
  const row = normalizeAsset(req.body || {});
  if (!await MAssetPack.findById(row.pack).lean(true)) throw new Error('资源包不存在');
  await assertAssetUnique(row);
  const now = new Date();
  const _id = v7();
  await MAsset.create({ _id, ...row, createdAt: now, updatedAt: now });
  await invalidatePackCache();
  res.json({ code: 0, data: { _id }, message: '已新增' });
}));

router.put('/assets/:id', wrap(async (req, res) => {
  const existing = await MAsset.findById(req.params.id).lean(true) as any;
  if (!existing) throw new Error('资源不存在');
  const row = normalizeAsset(req.body || {}, existing);
  await assertAssetUnique(row, req.params.id);
  await MAsset.updateOne({ _id: req.params.id }, { $set: { ...row, updatedAt: new Date() } });
  await invalidatePackCache();
  res.json({ code: 0, message: '已保存' });
}));

router.delete('/assets/:id', wrap(async (req, res) => {
  const existing = await MAsset.findById(req.params.id).lean(true) as any;
  if (!existing) throw new Error('资源不存在');
  await MPlayerAsset.deleteMany({ asset_id: req.params.id });
  await MAsset.deleteOne({ _id: req.params.id });
  await invalidatePackCache();
  res.json({ code: 0, message: '已删除' });
}));

/**
 * 上传资源文件：请求体是**原始二进制**（不是 multipart），文件名走 query。
 *
 * 用 raw body 而不是 multer：少一个依赖，前端 `fetch(url, { body: file })` 直接传 File 即可。
 * 落盘路径 `public/uploads/<game>/<group>/<随机>.<ext>`，静态目录已托管 → 立刻可访问。
 */
router.post('/assets/upload', rawBody({ type: () => true, limit: '24mb' }), wrap(async (req, res) => {
  const buf = req.body as Buffer;
  if (!Buffer.isBuffer(buf) || !buf.length) throw new Error('没有收到文件内容');
  const name = String(req.query.name || '');
  const ext = (name.includes('.') ? name.split('.').pop()! : '').toLowerCase();
  if (!UPLOAD_EXT.has(ext)) throw new Error(`不支持的文件类型：${ext || '未知'}（允许 ${[...UPLOAD_EXT].join('/')}）`);
  const game = req.query.game ? assertSlug(req.query.game, 'game') : 'common';
  const group = req.query.group ? assertSlug(req.query.group, 'group') : 'misc';
  const dir = path.join('public', 'uploads', game, group);
  await fs.mkdir(dir, { recursive: true });
  // 不用原始文件名：客户端可能带路径/中文/超长名，只保留扩展名
  const file = `${Date.now().toString(36)}-${crypto.randomBytes(4).toString('hex')}.${ext}`;
  await fs.writeFile(path.join(dir, file), buf);
  const url = `/uploads/${game}/${group}/${file}`;
  res.json({ code: 0, data: { url, size: buf.length, name: file }, message: '已上传' });
}));

/** 玩家搜索：授权前得先找到人 */
router.get('/players', wrap(async (req, res) => {
  const q = String(req.query.q || '').trim();
  const game = req.query.game ? String(req.query.game) : '';
  const query: Record<string, any> = { type: PLAYER.TYPE.player };
  if (game) query.game_id = game;
  if (q) query.$or = [{ nickname: new RegExp(q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i') }, { _id: q }];
  const rows = await MPlayer.find(query, { nickname: 1, game_id: 1, user_id: 1, skin: 1 }).limit(50).lean(true);
  res.json({ code: 0, data: rows });
}));

/** 某玩家额外获得的资源 */
router.get('/players/:pid/assets', wrap(async (req, res) => {
  res.json({ code: 0, data: await assetsService.listPlayerAssets(req.params.pid) });
}));

router.post('/players/:pid/assets', wrap(async (req, res) => {
  const assetId = String(req.body?.asset_id || '');
  if (!assetId) throw new Error('缺少 asset_id');
  if (!await MPlayer.findById(req.params.pid, { _id: 1 }).lean(true)) throw new Error('玩家不存在');
  await assetsService.grantAsset(req.params.pid, assetId, 'grant');
  res.json({ code: 0, message: '已授予' });
}));

router.delete('/players/:pid/assets/:assetId', wrap(async (req, res) => {
  await assetsService.revokeAsset(req.params.pid, req.params.assetId);
  res.json({ code: 0, message: '已撤销' });
}));

// ========== 房间 + 房内人机 ==========


router.get('/rooms', wrap(async (req, res) => {
  const query: any = { status: { $ne: ROOM.STATUS.deleted } };
  if (req.query.game_id) query.game_id = String(req.query.game_id);
  if (req.query.status) query.status = String(req.query.status);
  const rooms = await MRoom.find(query).sort({ updatedAt: -1 }).limit(300).lean(true);
  res.json({ code: 0, data: await withMemberDetail(rooms) });
}));

router.post('/rooms', wrap(async (req, res) => {
  const { game_id, name, official, variant, arena } = req.body || {};
  const game = await MGame.findById(String(game_id || '')).lean(true);
  if (!game) throw new Error('游戏不存在');
  // 竞技场属性跟着玩法走：选了 arena 玩法就建成常驻竞技桌（进房即开局、常驻 playing），
  // 除非显式传 arena=false 覆盖。
  const variantInfo = variant ? (game.variants || []).find((v: any) => v.key === variant) : null;
  const isArena = arena === undefined ? variantInfo?.arena === true : arena === true;
  const room = await roomService.createRoom({
    game_id: game._id,
    name: name || `${game.title} · 管理端新建`,
    owner_id: '',
    members: [],
    // 管理端建的房默认算官方桌：不可解散、任何人都能进
    official: official !== false,
    isPrivate: false,
    transient: false,
    allowSpectate: true,
    // 人数上限跟玩法走（竞技场 1–10 人，多人 2–30 人）
    numbers: variantInfo?.numbers || game.numbers,
    seats: [],
    settings: {
      ...(variant ? { variant } : {}),
      ...(isArena ? { arena: true } : {}),
    },
  } as any);
  res.json({ code: 0, data: room });
}));

router.post('/rooms/:id/robots', wrap(async (req, res) => {
  const result = await addRobotToRoom(req.params.id);
  if (!result.ok) throw new Error(result.message);
  res.json({ code: 0, data: result });
}));

router.delete('/rooms/:id/players/:pid', wrap(async (req, res) => {
  // 管理端操作：无"操作者"身份（`by` 不传），但业务约束照旧 —— 私有房主不可被踢
  const kicked = await roomService.kickPlayer(req.params.id, req.params.pid);
  if (!kicked.ok) throw new Error(`踢人失败：${kicked.reason || '未知原因'}`);
  res.json({ code: 0, message: '已移出房间' });
}));

router.delete('/rooms/:id', wrap(async (req, res) => {
  const room = await MRoom.findById(req.params.id).lean(true);
  if (!room) throw new Error('房间不存在');
  if (room.official) throw new Error('官方房间不可解散（destroyRoom 会静默忽略）');
  await roomService.destroyRoom(req.params.id);
  res.json({ code: 0, message: '已解散' });
}));

/** 数据自愈：清悬空成员、playing 却没对局的房间重置回等待、贪吃蛇运行时按库重建 */
router.post('/rooms/:id/heal', wrap(async (req, res) => {
  const room = await roomService.reconcileRoom(req.params.id);
  if (!room) throw new Error('房间不存在或已解散');
  const game = await MGame.findById(room.game_id, { slug: 1 }).lean(true) as any;
  let arena: any = null;
  if (game?.slug === 'snake' && room.status === ROOM.STATUS.playing) {
    arena = await roomService.ensureSnakeArena(room._id);
  }
  res.json({ code: 0, data: { status: room.status, arena } });
}));

export default router;
