/**
 * 好友接口（`SB-060` / `SB-061`）—— 全部需要 Bearer。
 * 主体是 **player_id**：Redis 存临时申请（30min TTL），MongoDB `friends` 存关系。
 * 按游戏隔离：列表/发申请/删除都带 slug，用当前用户在游戏的 player 身份操作。
 */
import { Router } from 'express';
import type { Server } from 'socket.io';
import { MPlayer, MMatch } from '../models';
import { httpAuth, type AuthedRequest } from '../middleware/httpAuth';
import redis from '../utils/redis';
import { playerService } from '../services/PlayerService';
import { FriendService, REQ_TTL, type FriendRequest } from '../services/FriendService';
import { RecentPlaymatesCache, RECENT_LIMIT, type RecentRedis } from '../services/RecentPlaymatesCache';

const router = Router();
const friends = new FriendService(redis as any);
const recentCache = new RecentPlaymatesCache(redis as unknown as RecentRedis);

const fail = (res: any, message: string) => res.json({ code: -1, message });

/** io 由 index.ts 注入，controller 不反向依赖 socket 初始化（避免循环引用） */
let friendIO: Server | null = null;
export function setFriendIO(io: Server) { friendIO = io; }

/** socket 只 join 了 user:${user_id}，按 player_id 反查 user_id 再定向推送 */
async function push(player_id: string, event: 'friend:request' | 'friend:result', payload: any) {
  if (!friendIO) return;
  try {
    const p = await MPlayer.findById(player_id, { user_id: 1 }).lean(true) as any;
    if (!p?.user_id) return;
    friendIO.to(`user:${p.user_id}`).emit(event, payload);
  } catch (err: any) {
    // 推送是附加体验，不能影响 HTTP 主流程
    console.log('好友推送失败:', err?.message || err);
  }
}

/** 玩家展示信息（昵称/头像/等级都是玩家级字段） */
async function present(ids: string[]) {
  if (!ids.length) return [] as any[];
  const players = await MPlayer.find({ _id: { $in: ids }, type: { $ne: 'robot' } }, {
    nickname: 1, avatar: 1, level: 1, atline: 1, type: 1,
  }).lean(true) as any[];
  return players.map(p => ({
    player_id: String(p._id),
    nickname: p.nickname || '玩家',
    avatar: p.avatar || '',
    level: p.level || 1,
    atline: !!p.atline,
  }));
}

const one = (v: any) => (Array.isArray(v) ? v[0] : v);

/** 当前用户的 player 身份：所有需要 slug 的接口共用 */
async function myPlayer(req: AuthedRequest) {
  const slug = String(one(req.query?.slug) || one(req.body?.slug) || '').trim();
  if (!slug) throw new Error('缺少 slug（好友按游戏隔离）');
  const player = await playerService.getOrCreatePlayer(req.user_id!, slug) as any;
  return { slug, me: String(player._id), game_id: String(player.game_id) };
}

router.use(httpAuth);

router.get('/', async (req: AuthedRequest, res) => {
  try {
    const { me } = await myPlayer(req);
    const ids = await friends.listFriendIds(me);
    res.json({ code: 0, data: { list: await present(ids) } });
  } catch (err: any) { fail(res, err.message); }
});

/**
 * 最近同玩（`SB-063`）：Redis ZSET 命中直接用，空则查 matches 回源。
 * 一条 match 存同场全部 players[]._id，按 game_id 隔离、跳过单人局与机器人。
 */
router.get('/recent', async (req: AuthedRequest, res) => {
  try {
    const { me, game_id } = await myPlayer(req);
    const cached = await recentCache.get(game_id, me);
    const last = new Map<string, number>(cached.map(r => [r.player_id, r.at]));
    let ids = cached.map(r => r.player_id);
    if (!ids.length) {
      const matches = await MMatch.find(
        { 'players._id': me, status: 'gameover', game_id },
        { players: 1, createdAt: 1, updatedAt: 1 },
      ).sort({ updatedAt: -1 }).limit(RECENT_LIMIT).lean(true) as any[];

      for (const m of matches) {
        if ((m.players || []).length <= 1) continue;
        const at = new Date(m.updatedAt || m.createdAt).getTime();
        for (const p of m.players) {
          const pid = String(p._id);
          if (pid !== me && !last.has(pid)) last.set(pid, at); // 倒序遍历，先出现的是最近一次
        }
      }
      ids = [...last.keys()];
      if (ids.length) {
        await recentCache.set(game_id, me, ids.map(pid => ({ player_id: pid, at: last.get(pid)! })));
      }
    }
    const users = await present(ids);
    res.json({
      code: 0,
      data: {
        list: users.map(u => ({
          ...u,
          last_played_at: last.get(u.player_id) ? new Date(last.get(u.player_id)!).toISOString() : '',
        })),
      },
    });
  } catch (err: any) { fail(res, err.message); }
});

router.get('/requests', async (req: AuthedRequest, res) => {
  try {
    const { me } = await myPlayer(req);
    const { incoming, outgoing } = await friends.listRequests(me);
    const other = (reqs: FriendRequest[]) => present(reqs.map(r => (r.from === me ? r.to : r.from)));
    const [inUsers, outUsers] = await Promise.all([other(incoming), other(outgoing)]);
    const withUsers = (reqs: FriendRequest[], users: any[]) => reqs.map(r => ({
      ...r,
      user: users.find(u => u.player_id === (r.from === me ? r.to : r.from)) || null,
    }));
    res.json({
      code: 0,
      data: {
        incoming: withUsers(incoming, inUsers),
        outgoing: withUsers(outgoing, outUsers),
      },
    });
  } catch (err: any) { fail(res, err.message); }
});

router.post('/requests', async (req: AuthedRequest, res) => {
  try {
    const { me, game_id } = await myPlayer(req);
    const target = String(req.body?.target || '').trim();
    if (!target) return fail(res, '请填写对方玩家 ID 或昵称');
    if (target === me) return fail(res, '不能添加自己为好友');

    // 只在本游戏内找人：player_id 或昵称（机器人不能加好友）
    const to = await MPlayer.findOne({
      game_id,
      type: { $ne: 'robot' },
      $or: [{ _id: target }, { nickname: target }],
    }, { _id: 1 }).lean(true) as any;
    if (!to) return fail(res, '该游戏内没有这个玩家');
    const to_id = String(to._id);
    if (await friends.isFriend(me, to_id)) return fail(res, '已经是好友了');
    if (await friends.hasPending(me, to_id) || await friends.hasPending(to_id, me)) {
      return fail(res, '已有待处理的好友申请');
    }

    const invite_id = await friends.createRequest(me, to_id);
    const fromUser = (await present([me]))[0] || { player_id: me, nickname: '玩家', avatar: '' };
    await push(to_id, 'friend:request', {
      invite_id,
      from: { player_id: me, nickname: fromUser.nickname, avatar: fromUser.avatar },
      created_at: String(Date.now()),
      expires_at: Date.now() + REQ_TTL * 1000,
    });
    res.json({ code: 0, data: { invite_id } });
  } catch (err: any) { fail(res, err.message); }
});

/** 接受/拒绝共用：只有收件的 player 所属用户能处理 */
async function respond(req: AuthedRequest, res: any, accept: boolean) {
  try {
    const id = String(req.params.id || '');
    const r = await friends.getRequest(id);
    if (!r) return fail(res, '申请不存在或已过期');
    const toPlayer = await MPlayer.findById(r.to, { user_id: 1 }).lean(true) as any;
    if (!toPlayer || toPlayer.user_id !== req.user_id) return fail(res, '只有收件人能处理该申请');

    if (accept) await friends.befriend(r.from, r.to);
    await friends.forget(id, r.from, r.to);

    const acceptedBy = (await present([r.to]))[0] || { player_id: r.to, nickname: '玩家', avatar: '' };
    await push(r.from, 'friend:result', {
      invite_id: id, accepted, player: acceptedBy,
      message: accept ? undefined : '对方拒绝',
    });
    res.json({ code: 0, data: true });
  } catch (err: any) { fail(res, err.message); }
}

router.post('/requests/:id/accept', (req: AuthedRequest, res) => respond(req, res, true));
router.post('/requests/:id/reject', (req: AuthedRequest, res) => respond(req, res, false));

router.delete('/requests/:id', async (req: AuthedRequest, res) => {
  try {
    const id = String(req.params.id || '');
    const r = await friends.getRequest(id);
    if (!r) return fail(res, '申请不存在或已过期');
    const fromPlayer = await MPlayer.findById(r.from, { user_id: 1 }).lean(true) as any;
    if (!fromPlayer || fromPlayer.user_id !== req.user_id) return fail(res, '只有发件人能撤回申请');
    await friends.forget(id, r.from, r.to);
    // 撤回通知的是收件人（他那边申请要消失），不是发件人
    await push(r.to, 'friend:result', { invite_id: id, accepted: false, message: '对方撤回了申请' });
    res.json({ code: 0, data: true });
  } catch (err: any) { fail(res, err.message); }
});

router.delete('/:player_id', async (req: AuthedRequest, res) => {
  try {
    const { me } = await myPlayer(req);
    await friends.removeFriend(me, req.params.player_id);
    res.json({ code: 0, data: true });
  } catch (err: any) { fail(res, err.message); }
});

export default router;
