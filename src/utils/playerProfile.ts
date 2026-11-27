import { z } from 'zod';
import { normalizeStats, winRate } from './stats';

/**
 * SB-065 玩家资料的只读模型：只暴露 player 表字段，绝不携带 user 表的
 * user_id / email / phone / pass。player 是每游戏一份的竞技身份，user 是账号。
 */
export function buildPlayerProfile(raw: any) {
  const stats = normalizeStats(raw?.stats);
  return {
    player_id: String(raw?._id ?? ''),
    nickname: raw?.nickname || '玩家',
    avatar: raw?.avatar || '',
    level: raw?.level ?? 1,
    score: raw?.score ?? 0,
    exp: raw?.exp ?? 0,
    boards: raw?.boards ?? {},
    stats,
    win_rate: winRate(stats),
  };
}

/** 玩家中心可改字段：与 user 资料同规则，但只写 player 表、只影响本游戏。 */
const VPlayerPatch = z.object({
  nickname: z.string().trim().min(1, '昵称不能为空').max(20, '昵称最多 20 个字符').optional(),
  avatar: z.string().trim().max(500, '头像地址过长').optional(),
});

export function buildPlayerUpdatePatch(input: any): Record<string, string> {
  const parsed = VPlayerPatch.safeParse(input ?? {});
  if (!parsed.success) {
    throw new Error(parsed.error.issues[0]?.message || '参数错误');
  }
  const patch: Record<string, string> = {};
  for (const [k, v] of Object.entries(parsed.data)) {
    if (v !== undefined) patch[k] = v as string;
  }
  if (!Object.keys(patch).length) throw new Error('没有需要修改的内容');
  return patch;
}
