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
import { Router } from 'express';
import crypto from 'node:crypto';
import jwt from 'jsonwebtoken';
import { v7 } from 'uuid';
import config from '../config';
import constant from '../constant';
import { MGame, MMatch, MPlayer, MRoom, MUser } from '../models';
import { addRobotToRoom } from '../services/RobotService';
import { roomService } from '../services/RoomService';
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
    })),
  });
}));

const GAME_WRITABLE = ['slug', 'title', 'desc', 'genre', 'icon', 'status', 'mode', 'numbers', 'variants', 'boards', 'role_config'];

router.post('/games', wrap(async (req, res) => {
  const body = req.body || {};
  const slug = String(body.slug || '').trim();
  if (!/^[a-z0-9-]+$/.test(slug)) throw new Error('slug 只能是小写字母、数字与中划线');
  if (await MGame.findOne({ slug }).lean(true)) throw new Error('slug 已存在');
  const game: any = { _id: v7(), status: 1, mode: 'room', numbers: { min: 2, max: 2 } };
  for (const k of GAME_WRITABLE) if (body[k] !== undefined) game[k] = body[k];
  game.slug = slug;
  game.title = game.title || slug;
  game.createdAt = game.updatedAt = new Date();
  await MGame.create(game);
  res.json({ code: 0, data: game, message: GameLogics[slug] ? '已创建' : '已创建，但该 slug 尚无服务端逻辑，开局会失败' });
}));

router.put('/games/:id', wrap(async (req, res) => {
  const patch: any = { updatedAt: new Date() };
  for (const k of GAME_WRITABLE) if (req.body?.[k] !== undefined) patch[k] = req.body[k];
  // 结构性字段（mode/variants/boards/numbers）在服务启动时会被 seed 校正覆盖，这里如实告知
  const structural = ['mode', 'variants', 'boards', 'numbers'].some(k => patch[k] !== undefined);
  await MGame.updateOne({ _id: req.params.id }, { $set: patch });
  res.json({ code: 0, message: structural ? '已保存；结构化字段在服务重启时会被种子数据校正，需同步改 seed.data.ts' : '已保存' });
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
  const { game_id, nickname, level } = req.body || {};
  const game = await MGame.findById(String(game_id || '')).lean(true);
  if (!game) throw new Error('游戏不存在');
  const suffix = v7().slice(0, 8);
  const player_id = `robot-player-${game.slug}-${suffix}`;
  const user_id = `robot-user-${game.slug}-${suffix}`;
  await MUser.create({
    _id: user_id,
    name: `🤖 ${nickname || '人机'}`,
    pass: md5(v7()),
    createdAt: new Date(),
  });
  await MPlayer.create({
    _id: player_id,
    user_id,
    game_id: game._id,
    room_id: '',
    nickname: nickname || '🤖 人机',
    type: PLAYER.TYPE.robot,
    state: PLAYER.STATE.online,
    level: Number(level) || 1,
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

// ========== 房间 + 房内人机 ==========

router.get('/rooms', wrap(async (req, res) => {
  const query: any = { status: { $ne: ROOM.STATUS.deleted } };
  if (req.query.game_id) query.game_id = String(req.query.game_id);
  if (req.query.status) query.status = String(req.query.status);
  const rooms = await MRoom.find(query).sort({ updatedAt: -1 }).limit(300).lean(true);
  res.json({ code: 0, data: await withMemberDetail(rooms) });
}));

router.post('/rooms', wrap(async (req, res) => {
  const { game_id, name, official, variant } = req.body || {};
  const game = await MGame.findById(String(game_id || '')).lean(true);
  if (!game) throw new Error('游戏不存在');
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
    numbers: game.numbers,
    seats: [],
    settings: variant ? { variant } : {},
  } as any);
  res.json({ code: 0, data: room });
}));

router.post('/rooms/:id/robots', wrap(async (req, res) => {
  const result = await addRobotToRoom(req.params.id);
  if (!result.ok) throw new Error(result.message);
  res.json({ code: 0, data: result });
}));

router.delete('/rooms/:id/players/:pid', wrap(async (req, res) => {
  const ok = await roomService.kickPlayer(req.params.id, req.params.pid);
  if (!ok) throw new Error('踢人失败（成员不存在或对方是房主）');
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
