import { Router } from 'express';
import { MGame, MMatch, MPlayer, MUser } from '../models';
import { oauthService } from '../services/OAuthService';
import { httpAuth, type AuthedRequest } from '../middleware/httpAuth';
import { normalizeStats, winRate } from '../utils/stats';
import { pick } from 'lodash';

const router = Router();

/**
 * 个人中心（本人）与公开主页共用一套读模型：
 * user + 该用户玩过的每个游戏一行战绩（等级/分数/场次/胜率）。
 */
async function loadProfile(user_id: string) {
  const user = await MUser.findById(user_id, { pass: 0 }).lean(true) as any;
  if (!user) return null;
  const players = await MPlayer.find({ user_id, type: 'player' }).lean(true) as any[];
  const games = await MGame.find({ _id: { $in: players.map(p => p.game_id) } }).lean(true) as any[];
  const gameMap = new Map(games.map(g => [String(g._id), g]));
  const rows = players
    .filter(p => gameMap.has(String(p.game_id)))
    .map(p => {
      const g = gameMap.get(String(p.game_id));
      const stats = normalizeStats(p.stats);
      return {
        game_id: p.game_id,
        slug: g.slug,
        title: g.title,
        icon: g.icon,
        level: p.level ?? 1,
        score: p.score ?? 0,
        exp: p.exp ?? 0,
        boards: p.boards || {},
        stats,
        win_rate: winRate(stats),
        last_played: p.updatedAt,
      };
    })
    // 最近玩的排前面：公开主页默认选中第一个
    .sort((a, b) => new Date(b.last_played || 0).getTime() - new Date(a.last_played || 0).getTime());

  return {
    user: {
      ...pick(user, ['_id', 'name', 'avatar', 'atline', 'createdAt']),
      nickname: user.nickname || user.name,
    },
    games: rows,
  };
}

/** 公开主页：任何登录/游客都能看（不暴露 email/phone） */
router.get('/:id/profile', async (req, res) => {
  try {
    const data = await loadProfile(req.params.id);
    if (!data) return res.json({ code: -1, message: '用户不存在' });
    res.json({ code: 0, data });
  } catch (err: any) {
    res.json({ code: -1, message: err.message });
  }
});

/**
 * 对局记录：分页，按结束时间倒序。
 * result：单人游戏 solo / 有胜者时 win|lose / 双方都没赢=draw。
 */
router.get('/:id/records', async (req, res) => {
  try {
    const { id } = req.params;
    const game_id = String(req.query.game_id || '');
    const limit = Math.min(50, Math.max(1, Number(req.query.limit) || 20));
    const skip = Math.max(0, Number(req.query.skip) || 0);

    const players = await MPlayer.find(
      { user_id: id, type: 'player', ...(game_id ? { game_id } : {}) },
      { _id: 1, game_id: 1 },
    ).lean(true) as any[];
    if (!players.length) return res.json({ code: 0, data: { total: 0, list: [] } });

    const mine = new Map(players.map(p => [String(p._id), String(p.game_id)]));
    const filter = { 'players._id': { $in: [...mine.keys()] }, status: 'gameover' };
    const total = await MMatch.countDocuments(filter);
    const matches = await MMatch.find(filter, {
      game_id: 1, players: 1, status: 1, createdAt: 1, updatedAt: 1, 'stats.scores': 1,
    }).sort({ updatedAt: -1 }).skip(skip).limit(limit).lean(true) as any[];

    // 一次补齐所有对局里出现的 player 昵称/头像
    const ids = new Set<string>();
    matches.forEach(m => (m.players || []).forEach((p: any) => ids.add(String(p._id))));
    const infos = await MPlayer.find({ _id: { $in: [...ids] } }, { nickname: 1, avatar: 1, user_id: 1 }).lean(true) as any[];
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
      const me = roster.find((p: any) => mine.has(String(p._id)));
      const hasWinner = roster.some((p: any) => p.is_winner);
      const result = roster.length <= 1
        ? 'solo'
        : me?.is_winner ? 'win' : hasWinner ? 'lose' : 'draw';
      return {
        _id: m._id,
        game_id: m.game_id,
        status: m.status,
        createdAt: m.createdAt,
        updatedAt: m.updatedAt,
        result,
        me,
        players: roster,
      };
    });

    res.json({ code: 0, data: { total, list } });
  } catch (err: any) {
    res.json({ code: -1, message: err.message });
  }
});

/** 改自己的资料（昵称/头像/手机/邮箱），同时同步到各游戏 player */
router.put('/profile', httpAuth, async (req: AuthedRequest, res) => {
  try {
    const user = await oauthService.updateProfile(req.user_id!, req.body || {});
    res.json({ code: 0, data: user });
  } catch (err: any) {
    res.json({ code: -1, message: err.message });
  }
});

/** 改密码：旧密码 + 新密码 */
router.post('/password', httpAuth, async (req: AuthedRequest, res) => {
  try {
    await oauthService.changePassword(req.user_id!, req.body?.old_pass, req.body?.new_pass);
    res.json({ code: 0, data: true });
  } catch (err: any) {
    res.json({ code: -1, message: err.message });
  }
});

export default router;
