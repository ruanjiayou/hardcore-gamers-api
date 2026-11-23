/**
 * 语音包服务。
 *
 * - 语音包配置存在 Mongo `voice_packs`，里面只放音频文件 URL，前端按 URL 加载播放。
 * - 「是否有权限」是计算出来的虚拟字段，不落库：库里只有用户的 `voicePackPerm` 权限位，
 *   服务端再叠加 etcd 的 `voice_pack_allowlist` 白名单，结果以 `hasVoicePackPermission`
 *   （用户）和 `hasPermission`（每个语音包）两个虚拟字段下发给前端。
 * - 没有权限的玩家只能使用默认包；选中了无权限包时一律回退到默认包。
 */
import jwt from 'jsonwebtoken';
import config from '../config';
import redis from '../utils/redis';
import { MUser, MVoicePack } from '../models';
import type { IUser, IVoicePack } from '../types';

export const DEFAULT_PACK_ID = 'classic';
export const SFX_KEYS = ['click', 'move', 'collect', 'win', 'lose'] as const;
const CACHE_KEY = () => config.prefix + 'voice-packs';

/** 用户是否有非默认语音包权限（虚拟字段，可由配置白名单扩展） */
export function hasVoicePackPermission(user: Partial<IUser> | null | undefined): boolean {
  if (!user) return false;
  if (user.voicePackPerm === true) return true;
  const list = Array.isArray(config.voice_pack_allowlist) ? config.voice_pack_allowlist : [];
  return !!user._id && list.includes(user._id);
}

/** 该玩家能否使用某个包：默认包永远可用 */
export function canUsePack(pack: Partial<IVoicePack>, user: Partial<IUser> | null | undefined): boolean {
  if (pack.isDefault || pack.requirePermission === false) return true;
  return hasVoicePackPermission(user);
}

/** 输出给前端的语音包 DTO；hasPermission 是 getter 虚拟字段，JSON 序列化时可见但不存库 */
export function toPackDTO(pack: IVoicePack | any, user: Partial<IUser> | null | undefined) {
  const dto: any = {
    id: pack._id,
    name: pack.name,
    desc: pack.desc || '',
    cover: pack.cover || '',
    isDefault: !!pack.isDefault,
    requirePermission: !!pack.requirePermission,
    bgm: (pack.bgm || []).map((t: any) => ({ url: t.url, label: t.label || '' })),
    sfx: { ...(pack.sfx || {}) },
    // 游戏专属配置原样下发；前端进入游戏时按 game_id 取，URL 由服务端下发
    games: Object.fromEntries(
      Object.entries(pack.games || {}).map(([gameId, audio]: [string, any]) => [
        gameId,
        {
          bgm: (audio?.bgm || []).map((t: any) => ({ url: t.url, label: t.label || '' })),
          sfx: { ...(audio?.sfx || {}) },
        },
      ]),
    ),
  };
  Object.defineProperty(dto, 'hasPermission', {
    enumerable: true,
    get: () => canUsePack(pack, user),
  });
  return dto;
}

/**
 * 解析某个游戏实际生效的音频配置：
 * - 游戏级 sfx 按 key 覆盖包级 sfx（例如棋类各自的 move 音）
 * - 游戏级 bgm 若配置则整体覆盖包级 bgm，否则沿用包级
 * 未传 gameId 或该游戏未单独配置时，返回包级通用配置。
 */
export function resolveGameAudio(
  pack: Partial<IVoicePack> | null | undefined,
  gameId?: string,
): { bgm: { url: string; label?: string }[]; sfx: Record<string, string> } {
  const base = {
    bgm: (pack?.bgm || []).map(t => ({ url: t.url, label: t.label || '' })),
    sfx: { ...(pack?.sfx || {}) } as Record<string, string>,
  };
  if (!gameId) return base;
  const game = pack?.games?.[gameId];
  if (!game) return base;
  return {
    bgm: game.bgm?.length ? game.bgm : base.bgm,
    sfx: { ...base.sfx, ...(game.sfx || {}) },
  };
}

/** 校验选择是否合法：包必须启用且当前玩家有权限 */
export function validateSelection(
  pack: IVoicePack | null | undefined,
  user: Partial<IUser> | null | undefined,
): boolean {
  return !!pack && pack.status !== 0 && canUsePack(pack, user);
}

async function cachedPacks(): Promise<IVoicePack[]> {
  try {
    const raw = await redis.get(CACHE_KEY());
    if (raw) return JSON.parse(raw) as IVoicePack[];
  } catch (err) {
    console.warn('[voice-pack] 读取缓存失败，回源 Mongo', err);
  }
  const packs = await MVoicePack.find({ status: 1 }).lean(true) as IVoicePack[];
  try {
    await redis.set(CACHE_KEY(), JSON.stringify(packs), 'EX', 300);
  } catch { /* 缓存失败不影响主流程 */ }
  return packs;
}

export function invalidatePackCache() {
  return redis.del(CACHE_KEY()).catch(() => 0);
}

/** 解析 HTTP Bearer token；无效/缺失返回 null（游客） */
export function userFromRequest(req: { headers: Record<string, any> }): Partial<IUser> | null {
  const header = req.headers.authorization || '';
  const match = /^Bearer\s+(.+)$/i.exec(header);
  if (!match) return null;
  try {
    const payload: any = jwt.verify(match[1], config.secret);
    return payload?._id ? { _id: payload._id, name: payload.name } : null;
  } catch {
    return null;
  }
}

export class VoicePackService {
  /** 列表 + 虚拟权限字段 + 当前选择（无权限/失效时回退默认包） */
  async listForUser(userId?: string) {
    const user = userId ? await MUser.findById(userId, { pass: 0 }).lean(true) : null;
    const packs = await cachedPacks();
    const defaultPack = packs.find(p => p.isDefault) || packs.find(p => p._id === DEFAULT_PACK_ID);
    const selected = packs.find(p => p._id === (user as any)?.voice_pack);
    const effective = selected && validateSelection(selected, user as any)
      ? selected
      : defaultPack;
    return {
      list: packs.map(p => toPackDTO(p, user as any)),
      selected: effective ? effective._id : DEFAULT_PACK_ID,
      hasPermission: hasVoicePackPermission(user as any),
    };
  }

  /** 选择语音包；无权限或非默认包被禁用时拒绝 */
  async selectPack(userId: string, packId: string) {
    const user = await MUser.findById(userId, { pass: 0 }).lean(true);
    if (!user) throw new Error('请先登录');
    const pack = await MVoicePack.findById(packId).lean(true) as IVoicePack | null;
    if (!validateSelection(pack, user as any)) throw new Error('该语音包不可用或无权限');
    await MUser.updateOne({ _id: userId }, { $set: { voice_pack: packId, updatedAt: new Date() } });
    return { selected: packId, hasPermission: hasVoicePackPermission(user as any) };
  }
}

export const voicePackService = new VoicePackService();
