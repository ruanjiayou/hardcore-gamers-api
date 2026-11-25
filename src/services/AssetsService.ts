/**
 * 资源服务：`asset_packs`（包元信息）+ `assets`（一行一条资源）+ `player_assets`（授权）。
 *
 * 为什么从「一个包一个大对象」改成行结构：
 * 不同资源的字段根本不同——BGM 要循环/时长，音效要 key（move/collect/click），
 * 食物按档位（small/mid/big），道具按注册表 key，蛇皮肤还带画风。塞进一个 Mixed
 * 就只能靠约定，改一项要整块覆盖。拆成行之后加一种资源只是加一行。
 *
 * 对局内不发图片请求：前端进游戏前拉一次 `manifest.json`，把所有图 URL 一次拿到并
 * 预解码；快照与 `match.players` 只引用 asset_id，没有 URL。
 *
 * 多层回退（主题只配了部分资源也能用）：
 *   默认包·通用 → 默认包·本游戏 → 选中包·通用 → 选中包·本游戏（后者覆盖前者）
 */
import { MAsset, MAssetPack, MGame, MPlayer, MPlayerAsset } from '../models';
import type { IAsset, IAssetPack, IPlayerAsset } from '../types';
import { playerService } from './PlayerService';

export const DEFAULT_PACK_ID = 'classic';
/** 内置分组：bgm / sfx（音频），food / items / snake（图片）。可扩展 */
export const ASSET_GROUPS = ['bgm', 'sfx', 'food', 'items', 'snake'] as const;
/** 图片类分组（会被 manifest 预加载） */
export const IMAGE_GROUPS = ['food', 'items', 'snake'] as const;
/** 普通食物三档 key（与客户端 foodTierIndex 对齐） */
export const FOOD_KEYS = ['small', 'mid', 'big'] as const;
/** 默认蛇皮肤 key：任何包都应有，缺图时客户端回退矢量绘制 */
export const DEFAULT_SKIN_KEY = 'default';

const GROUP_KIND: Record<string, 'audio' | 'image'> = {
  bgm: 'audio',
  sfx: 'audio',
  food: 'image',
  items: 'image',
  snake: 'image',
};

/** 分组默认的资源类型；自定义分组未登记时按图片处理 */
export function kindOfGroup(group: string): 'audio' | 'image' {
  return GROUP_KIND[group] || 'image';
}

/** 玩家可选/装备的蛇皮肤 asset（group=snake） */
export function isSkinAsset(asset: Pick<IAsset, 'group' | 'kind'>): boolean {
  return asset.group === 'snake' && asset.kind === 'image';
}

export interface AssetsManifest {
  game: string;
  pack: string;
  /** 缓存键：包或资源改过就变，前端据此失效预加载 */
  revision: string;
  /** 全部图片：asset_id → url（前端加载阶段逐个 decode，对局内零请求） */
  images: Record<string, string>;
  /** 食物三档：`small|mid|big` → asset_id */
  food: Record<string, string>;
  /** 道具：道具注册表 key → asset_id */
  items: Record<string, string>;
  /** 蛇皮肤可选项（玩家级；owned 决定能不能选，equipped 是当前装备） */
  skins: { id: string; key: string; label: string; url: string; owned: boolean; equipped: boolean }[];
  /** 当前玩家装备的蛇皮肤 asset_id；游客/未选为 '' */
  equipped: string;
  /** 音频：BGM 列表 + 音效表，随清单一次下发，省一次往返 */
  audio: { bgm: { url: string; label: string }[]; sfx: Record<string, string> };
}

/** 挑包：指定包要启用；否则用玩家选的包；再不然默认包 */
export function pickPack(packs: IAssetPack[], packId?: string): IAssetPack | undefined {
  const wanted = packId ? packs.find(p => p._id === packId) : undefined;
  if (wanted) return wanted;
  return packs.find(p => p.isDefault) || packs.find(p => p._id === DEFAULT_PACK_ID) || packs[0];
}

/**
 * 合并多层资源（后者覆盖同 `group:key` 的前者）。
 * 顺序保证「游戏级」永远压在「通用」上面。
 */
function mergeRows(...layers: IAsset[][]): Map<string, IAsset> {
  const out = new Map<string, IAsset>();
  for (const rows of layers) {
    for (const row of rows) out.set(`${row.group}:${row.key}`, row);
  }
  return out;
}

/** 把资源行拆成 manifest 的各个块（纯函数，单测直接喂数据） */
export function composeManifest(
  packs: IAssetPack[],
  assets: IAsset[],
  options: {
    game: string;
    packId?: string;
    /** 玩家已装备的皮肤 asset_id */
    equipped?: string;
    /** 玩家额外拥有的 asset_id（`player_assets`） */
    owned?: Set<string>;
  },
): AssetsManifest {
  const pack = pickPack(packs, options.packId);
  const defaultPack = packs.find(p => p.isDefault);
  const game = options.game;

  const rowsOf = (p?: IAssetPack) => (p ? assets.filter(a => a.pack === p._id && a.status !== 0) : []);
  const defaultRows = rowsOf(defaultPack);
  const packRows = rowsOf(pack);
  const rows = mergeRows(
    defaultRows.filter(a => a.game === ''),
    defaultRows.filter(a => a.game === game),
    packRows.filter(a => a.game === ''),
    packRows.filter(a => a.game === game),
  );

  const images: Record<string, string> = {};
  const food: Record<string, string> = {};
  const items: Record<string, string> = {};
  const skinRows: IAsset[] = [];
  const bgm: { url: string; label: string }[] = [];
  const sfx: Record<string, string> = {};

  for (const asset of rows.values()) {
    if (!asset.url) continue;
    if (asset.kind === 'image') {
      images[asset._id] = asset.url;
      if (asset.group === 'food') food[asset.key] = asset._id;
      else if (asset.group === 'items') items[asset.key] = asset._id;
      else if (asset.group === 'snake') skinRows.push(asset);
    } else if (asset.group === 'bgm') {
      bgm.push({ url: asset.url, label: asset.label || asset.key });
    } else if (asset.group === 'sfx') {
      sfx[asset.key] = asset.url;
    }
  }

  skinRows.sort((a, b) => (a.order - b.order) || a.key.localeCompare(b.key));
  const owned = options.owned;
  const canUse = (a: IAsset) => a.free || !!owned?.has(a._id);
  // 装备值必须「存在且有权使用」：撤销授权后不能还顶着一个自己没有的皮肤
  const equipped = options.equipped && skinRows.some(a => a._id === options.equipped && canUse(a))
    ? options.equipped
    : '';

  // 只改资源不改包时 revision 也要变，否则前端一直用旧缓存
  const stamps = [pack?.updatedAt, ...assets.filter(a => a.pack === pack?._id).map(a => a.updatedAt)]
    .map(t => new Date(t || 0).getTime())
    .filter(t => t > 0);
  const revision = `${pack?._id || DEFAULT_PACK_ID}:${game}:${stamps.length ? Math.max(...stamps) : 0}`;

  return {
    game,
    pack: pack?._id || DEFAULT_PACK_ID,
    revision,
    images,
    food,
    items,
    skins: skinRows.map(a => ({
      id: a._id,
      key: a.key,
      label: a.label || a.key,
      url: a.url,
      owned: canUse(a),
      equipped: a._id === equipped,
    })),
    equipped,
    audio: { bgm, sfx },
  };
}

async function loadCatalog() {
  const [packs, assets] = await Promise.all([
    MAssetPack.find({}).lean(true) as Promise<IAssetPack[]>,
    MAsset.find({ status: { $ne: 0 } }).lean(true) as Promise<IAsset[]>,
  ]);
  return { packs, assets };
}

/** 玩家额外拥有的资源 id 集合（free 不落表，判定时按资源自身字段） */
export async function ownedAssetIds(playerId?: string): Promise<Set<string>> {
  if (!playerId) return new Set();
  const rows = await MPlayerAsset.find({ player_id: playerId }, { asset_id: 1 }).lean(true);
  return new Set(rows.map(r => String((r as any).asset_id)));
}

/** 按 (user_id, game slug/_id) 找 player，找不到返回 undefined */
export async function findPlayerId(userId: string, game: string): Promise<string | undefined> {
  const g = await MGame.findOne({ $or: [{ _id: game }, { slug: game }] }, { _id: 1 }).lean(true) as any;
  if (!g) return undefined;
  const p = await MPlayer.findOne({ user_id: userId, game_id: g._id }, { _id: 1 })
    .sort({ updatedAt: -1, createdAt: -1 })
    .lean(true) as any;
  return p?._id ? String(p._id) : undefined;
}

/** 该玩家在这个游戏里装备的皮肤 asset_id */
async function equippedSkinOf(playerId?: string): Promise<string> {
  if (!playerId) return '';
  const p = await MPlayer.findById(playerId, { skin: 1 }).lean(true) as any;
  return p?.skin ? String(p.skin) : '';
}

/**
 * 组装 manifest。
 * @param playerId 玩家 id（`players._id`）：取装备的皮肤与额外授权；游客传空
 * @param userId   未建角色的玩家可传账号 id 兜底查一次
 */
export async function buildManifest(options: {
  game: string;
  packId?: string;
  playerId?: string;
  userId?: string;
}): Promise<AssetsManifest> {
  const { packs, assets } = await loadCatalog();
  let pid = options.playerId;
  if (!pid && options.userId) pid = await findPlayerId(options.userId, options.game);
  const [equipped, owned] = await Promise.all([
    equippedSkinOf(pid),
    ownedAssetIds(pid),
  ]);
  const enabled = packs.filter(p => p.status !== 0);
  return composeManifest(enabled, assets, { game: options.game, packId: options.packId, equipped, owned });
}

/** 包列表 */
export async function listPacks(): Promise<IAssetPack[]> {
  return await MAssetPack.find({}).sort({ isDefault: -1, createdAt: 1 }).lean(true) as IAssetPack[];
}

/** 某个包对某个游戏实际生效的音频（`/api/voice-packs` 的 games 字段靠它组装） */
export async function audioForPack(packId: string, game: string) {
  const { packs, assets } = await loadCatalog();
  return composeManifest(packs, assets, { game, packId }).audio;
}

/**
 * 玩家装备蛇皮肤（按 asset_id）。
 * 必须校验：资源存在、是皮肤、且 free 或已被授予——否则谁都能穿付费皮肤。
 */
export async function equipSkin(userId: string, game: string, assetId: string): Promise<{ skin: string }> {
  const asset = await MAsset.findById(String(assetId || '')).lean(true) as IAsset | null;
  if (!asset || asset.status === 0) throw new Error('该皮肤不存在或已下架');
  if (!isSkinAsset(asset)) throw new Error('该资源不是蛇皮肤');

  // 未进过游戏的玩家也会在这里被建出 player 记录：皮肤是玩家级属性，得有承载
  const player = await playerService.getOrCreatePlayer(userId, game);
  if (!asset.free) {
    const owned = await MPlayerAsset.findOne({ player_id: player._id, asset_id: asset._id }).lean(true);
    if (!owned) throw new Error('还没有这个皮肤，先去获得它');
  }
  await MPlayer.updateOne(
    { _id: player._id },
    { $set: { skin: asset._id, updatedAt: new Date() } },
  );
  return { skin: asset._id };
}

/** 授予玩家资源（后台用） */
export async function grantAsset(playerId: string, assetId: string, source: IPlayerAsset['source'] = 'grant') {
  const asset = await MAsset.findById(assetId, { _id: 1 }).lean(true);
  if (!asset) throw new Error('资源不存在');
  await MPlayerAsset.updateOne(
    { player_id: playerId, asset_id: assetId },
    { $set: { source, createdAt: new Date() } },
    { upsert: true },
  );
}

/**
 * 撤权要做的两件事（纯函数，便于单测）：
 * 1. 删掉这条授权；
 * 2. 如果该玩家正好装备着这个皮肤，把 `players.skin` 清空。
 *
 * 第 2 步的过滤条件**必须带 `skin: assetId`**：少了它就会把这个玩家装备的
 * 其它皮肤也一起清掉（那是别人的皮肤，白白被卸）。
 */
export function planRevoke(playerId: string, assetId: string) {
  return {
    deleteGrant: { player_id: playerId, asset_id: assetId },
    unloadSkin: { _id: playerId, skin: assetId },
  };
}

export async function revokeAsset(playerId: string, assetId: string) {
  const plan = planRevoke(playerId, assetId);
  await MPlayerAsset.deleteOne(plan.deleteGrant);
  // 撤权同时卸下：否则玩家档案里还挂着一个自己已经没有的皮肤，
  // 快照照发（别的客户端还会画出来），只是自己 manifest 里 owned=false，状态自相矛盾
  await MPlayer.updateOne(plan.unloadSkin, { $set: { skin: '', updatedAt: new Date() } });
}

/** 玩家持有（额外授予）的资源明细 */
export async function listPlayerAssets(playerId: string) {
  const rows = await MPlayerAsset.find({ player_id: playerId }).lean(true) as IPlayerAsset[];
  const ids = rows.map(r => r.asset_id);
  const assets = ids.length
    ? await MAsset.find({ _id: { $in: ids } }).lean(true) as IAsset[]
    : [];
  const byId = new Map(assets.map(a => [a._id, a]));
  return rows.map(r => ({ ...r, asset: byId.get(r.asset_id) || null }));
}

/** 删包：连带清掉它的资源与授权（否则留下永远取不到的孤儿授权） */
export async function purgePack(packId: string) {
  const ids = (await MAsset.find({ pack: packId }, { _id: 1 }).lean(true)).map(a => String((a as any)._id));
  if (ids.length) await MPlayerAsset.deleteMany({ asset_id: { $in: ids } });
  await MAsset.deleteMany({ pack: packId });
  await MAssetPack.deleteOne({ _id: packId });
}

export const assetsService = {
  buildManifest,
  equipSkin,
  listPacks,
  audioForPack,
  grantAsset,
  revokeAsset,
  listPlayerAssets,
  ownedAssetIds,
  findPlayerId,
  purgePack,
};
