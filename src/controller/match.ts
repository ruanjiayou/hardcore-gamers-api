import { Router } from 'express';
import { MMatch, MPlayer } from '../models';

const router = Router();

/** 棋类才有回放（棋盘 + 着法）；2048/俄罗斯方块/贪吃蛇的记录不提供回放 */
const REPLAY_GAMES = new Set(['gomoku', 'xiangqi', 'othello', 'international-chess']);

/**
 * 对局回放数据。
 * frames 来自 `movements[].board`（每次落子时服务端存的棋盘快照），
 * 客户端按帧渲染即可，不需要在前端重放各游戏的规则。
 * 老对局没有快照时 frames 为空，前端退化成只显示终局棋盘（curr_state.board）。
 */
router.get('/:id/replay', async (req, res) => {
  try {
    const match = await MMatch.findById(req.params.id).lean(true) as any;
    if (!match) return res.json({ code: -1, message: '对局不存在' });
    if (!REPLAY_GAMES.has(String(match.game_id))) {
      return res.json({ code: -1, message: '该游戏暂不支持回放' });
    }

    const ids = (match.players || []).map((p: any) => String(p._id));
    const infos = await MPlayer.find({ _id: { $in: ids } }, { nickname: 1, avatar: 1 }).lean(true) as any[];
    const infoMap = new Map(infos.map(p => [String(p._id), p]));

    const frames = (match.movements || [])
      .filter((m: any) => m && m.board)
      .map((m: any, i: number) => ({ index: i + 1, board: m.board, at: m.timestamp || 0, player_id: m.player_id }));

    res.json({
      code: 0,
      data: {
        _id: match._id,
        game_id: match.game_id,
        status: match.status,
        createdAt: match.createdAt,
        updatedAt: match.updatedAt,
        players: (match.players || []).map((p: any) => ({
          _id: p._id,
          role: p.role || '',
          team: p.team || '',
          score: p.score ?? 0,
          is_winner: !!p.is_winner,
          nickname: infoMap.get(String(p._id))?.nickname || '玩家',
          avatar: infoMap.get(String(p._id))?.avatar || '',
        })),
        init_state: match.init_state,
        final_board: match.curr_state?.board ?? null,
        frames,
      },
    });
  } catch (err: any) {
    res.json({ code: -1, message: err.message });
  }
});

export default router;
