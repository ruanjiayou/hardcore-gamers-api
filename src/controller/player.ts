/**
 * 玩家资料接口（SB-065）—— 玩家是 player 表数据（每游戏一条竞技身份），
 * 用户是 user 表数据（账号）。两者严格分离：本 router 只读写 player 表。
 *
 * 公开资料按 player_id 读取（玩家公开主页）；本人资料按 user_id + game 定位
 * （玩家中心），编辑仅接受昵称/头像，不回写 user 表。
 */
import { Router } from 'express';
import { MGame, MMatch, MPlayer } from '../models';
import { httpAuth, type AuthedRequest } from '../middleware/httpAuth';
import { buildPlayerProfile, buildPlayerUpdatePatch } from '../utils/playerProfile';

const router = Router();
const fail = (res: any, message: string) => res.json({ code: -1, message });

/** slug 既接受 game._id 也接受 slug，与 AssetsService.findPlayerId 一致 */
async function gameIdOf(name: string): Promise<string | undefined> {
  const g = await MGame.findOne({ $or: [{ _id: name }, { slug: name }] }, { _id: 1 }).lean(true) as any;
  return g?._id ? String(g._id) : undefined;
}

/** 公开：按 player_id + 游戏取玩家资料（玩家公开主页） */
router.get('/:slug/profile/:player_id', async (req, res) => {
  try {
    const game_id = await gameIdOf(req.params.slug);
    if (!game_id) return fail(res, '游戏不存在');
    const player = await MPlayer.findOne(
      { _id: req.params.player_id, game_id, type: 'player' },
    ).lean(true) as any;
    if (!player) return fail(res, '玩家不存在');
    res.json({ code: 0, data: { player: buildPlayerProfile(player) } });
  } catch (err: any) {
    fail(res, err.message);
  }
});

/**
 * 公开：按 player_id + 游戏查对局记录（玩家公开主页的「对局记录」tab）。
 * 与 `/api/users/:id/records`（按 user_id 跨游戏）不同，这里只查这一个 player 的对局。
 */
router.get('/:slug/profile/:player_id/records', async (req, res) => {
  try {
    const game_id = await gameIdOf(req.params.slug);
    if (!game_id) return fail(res, '游戏不存在');
    const player_id = req.params.player_id;
    const limit = Math.min(50, Math.max(1, Number(req.query.limit) || 20));
    const skip = Math.max(0, Number(req.query.skip) || 0);
    const filter = { game_id, 'players._id': player_id, status: 'gameover' };
    const total = await MMatch.countDocuments(filter);
    const matches = await MMatch.find(filter, {
      game_id: 1, players: 1, status: 1, createdAt: 1, updatedAt: 1, 'stats.scores': 1,
    }).sort({ updatedAt: -1 }).skip(skip).limit(limit).lean(true) as any[];

    const ids = new Set<string>();
    matches.forEach(m => (m.players || []).forEach((p: any) => ids.add(String(p._id))));
    const infos = await MPlayer.find({ _id: { $in: [...ids] } }, { nickname: 1, avatar: 1 }).lean(true) as any[];
    const infoMap = new Map(infos.map(p => [String(p._id), p]));

    const list = matches.map(m => {
      const roster = (m.players || []).map((p: any) => ({
        _id: p._id,
        role: p.role || '',
        score: p.score ?? 0,
        is_winner: !!p.is_winner,
        nickname: infoMap.get(String(p._id))?.nickname || '玩家',
        avatar: infoMap.get(String(p._id))?.avatar || '',
      }));
      const me = roster.find((p: any) => String(p._id) === player_id);
      const hasWinner = roster.some((p: any) => p.is_winner);
      const result = roster.length <= 1 ? 'solo' : me?.is_winner ? 'win' : hasWinner ? 'lose' : 'draw';
      return { _id: m._id, game_id: m.game_id, status: m.status, createdAt: m.createdAt, updatedAt: m.updatedAt, result, me, players: roster };
    });
    res.json({ code: 0, data: { total, list } });
  } catch (err: any) {
    fail(res, err.message);
  }
});

/** 本人：按 user_id + 游戏定位自己的 player（玩家中心） */
router.get('/:slug/me', httpAuth, async (req: AuthedRequest, res) => {
  try {
    const game_id = await gameIdOf(req.params.slug);
    if (!game_id) return fail(res, '游戏不存在');
    const player = await MPlayer.findOne(
      { user_id: req.user_id!, game_id, type: 'player' },
      {},
    ).sort({ updatedAt: -1, createdAt: -1 }).lean(true) as any;
    if (!player) return fail(res, '玩家不存在');
    res.json({ code: 0, data: { player: buildPlayerProfile(player) } });
  } catch (err: any) {
    fail(res, err.message);
  }
});

/** 本人：只改本游戏 player 的昵称/头像，不回写 user 表 */
router.put('/:slug/me', httpAuth, async (req: AuthedRequest, res) => {
  try {
    const patch = buildPlayerUpdatePatch(req.body);
    const game_id = await gameIdOf(req.params.slug);
    if (!game_id) return fail(res, '游戏不存在');
    const player = await MPlayer.findOneAndUpdate(
      { user_id: req.user_id!, game_id, type: 'player' },
      { $set: { ...patch, updatedAt: new Date() } },
      { new: true },
    ).lean(true) as any;
    if (!player) return fail(res, '玩家不存在');
    res.json({ code: 0, data: { player: buildPlayerProfile(player) } });
  } catch (err: any) {
    fail(res, err.message);
  }
});

export default router;
