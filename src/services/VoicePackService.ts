/**
 * 资源包（原「语音包」）的服务层：**只管包本身与玩家选择**。
 *
 * 资源明细已经搬到 `assets` 表（一行一条），这里不再承载 bgm/sfx/skins 的对象结构。
 * 音频与图片统一从 `GET /api/assets/manifest.json` 取（同一份数据源、同一个 revision），
 * 避免「包接口」和「清单接口」各下发一份导致状态分裂。
 *
 * 权限是算出来的虚拟字段，不落库：库里只有 `users.voicePackPerm` 权限位，
 * 服务端再叠加 etcd 的 `voice_pack_allowlist` 白名单。
 */
import jwt from 'jsonwebtoken';
import config from '../config';
import redis from '../utils/redis';
import { MAssetPack, MUser } from '../models';
import type { IAssetPack, IUser } from '../types';
import { DEFAULT_PACK_ID } from './AssetsService';

export const SFX_KEYS = ['click', 'move', 'collect', 'win', 'lose'] as const;
const CACHE_KEY = () => config.prefix + 'asset-packs';

/** 用户是否有非默认包权限（可由配置白名单扩展） */
export function hasVoicePackPermission(user: Partial<IUser> | null | undefined): boolean {
  if (!user) return false;
  if (user.voicePackPerm === true) return true;
  const list = Array.isArray(config.voice_pack_allowlist) ? config.voice_pack_allowlist : [];
  return !!user._id && list.includes(user._id);
}

/** 该玩家能否使用某个包：默认包永久可用 */
export function canUsePack(pack: Partial<IAssetPack>, user: Partial<IUser> | null | undefined): boolean {
  if (pack.isDefault || pack.requirePermission === false) return true;
  return hasVoicePackPermission(user);
}

/** 输出给前端的包 DTO（只描述包，不含资源明细） */
export function toPackDTO(pack: IAssetPack, user: Partial<IUser> | null | undefined) {
  return {
    id: pack._id,
    name: pack.name,
    desc: pack.desc || '',
    cover: pack.cover || '',
    isDefault: !!pack.isDefault,
    requirePermission: !!pack.requirePermission,
    hasPermission: canUsePack(pack, user),
  };
}

export function validateSelection(
  pack: IAssetPack | null | undefined,
  user: Partial<IUser> | null | undefined,
): boolean {
  return !!pack && pack.status !== 0 && canUsePack(pack, user);
}

async function cachedPacks(): Promise<IAssetPack[]> {
  try {
    const raw = await redis.get(CACHE_KEY());
    if (raw) return JSON.parse(raw) as IAssetPack[];
  } catch (err) {
    console.warn('[asset-pack] 读取缓存失败，回源 Mongo', err);
  }
  const packs = await MAssetPack.find({ status: 1 }).sort({ isDefault: -1, createdAt: 1 }).lean(true) as IAssetPack[];
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
  /** 包列表 + 虚拟权限字段 + 当前选择（无权限/失效时回退默认包） */
  async listForUser(userId?: string) {
    const user = userId ? await MUser.findById(userId, { pass: 0 }).lean(true) : null;
    const packs = await cachedPacks();
    const defaultPack = packs.find(p => p.isDefault) || packs.find(p => p._id === DEFAULT_PACK_ID);
    const selected = packs.find(p => p._id === (user as any)?.voice_pack);
    const effective = selected && validateSelection(selected, user as any) ? selected : defaultPack;
    return {
      list: packs.map(p => toPackDTO(p, user as any)),
      selected: effective ? effective._id : DEFAULT_PACK_ID,
      hasPermission: hasVoicePackPermission(user as any),
    };
  }

  /** 玩家当前生效的包 id（无权限/失效回退默认包） */
  async effectivePackId(userId?: string): Promise<string> {
    if (!userId) return DEFAULT_PACK_ID;
    const user = await MUser.findById(userId, { voice_pack: 1, voicePackPerm: 1 }).lean(true);
    const packs = await cachedPacks();
    const selected = packs.find(p => p._id === (user as any)?.voice_pack);
    if (selected && validateSelection(selected, user as any)) return selected._id;
    return packs.find(p => p.isDefault)?._id || DEFAULT_PACK_ID;
  }

  /**
   * 解析本次请求真正生效的包：显式指定且有权就用它，否则用玩家选的包，
   * 再否则默认包。前端拿到返回的 `pack` 与本地的对比就知道有没有被降级。
   */
  async resolvePackId(userId: string | undefined, wanted?: string): Promise<string> {
    const packs = await cachedPacks();
    const user = userId ? await MUser.findById(userId, { voicePackPerm: 1 }).lean(true) : null;
    const picked = wanted ? packs.find(p => p._id === wanted) : undefined;
    if (picked && validateSelection(picked, user as any)) return picked._id;
    const selected = packs.find(p => p._id === (user as any)?.voice_pack);
    if (selected && validateSelection(selected, user as any)) return selected._id;
    return packs.find(p => p.isDefault)?._id || DEFAULT_PACK_ID;
  }

  /** 选择资源包；无权限或已下架时拒绝 */
  async selectPack(userId: string, packId: string) {
    const user = await MUser.findById(userId, { pass: 0 }).lean(true);
    if (!user) throw new Error('请先登录');
    const pack = await MAssetPack.findById(packId).lean(true) as IAssetPack | null;
    if (!validateSelection(pack, user as any)) throw new Error('该资源包不可用或无权限');
    await MUser.updateOne({ _id: userId }, { $set: { voice_pack: packId, updatedAt: new Date() } });
    return { selected: packId, hasPermission: hasVoicePackPermission(user as any) };
  }
}

export const voicePackService = new VoicePackService();
