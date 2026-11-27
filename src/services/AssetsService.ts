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
 *
 * **按游戏隔离**：清单只包含 `game` 等于当前游戏（外加通用层）的资源，
 * 所以黑白棋的设置里不会出现贪吃蛇的皮肤或音效；每个游戏的外观分组、音频配置
 * 都是自己那一份，改一个游戏不影响别的游戏。
 */
import { MAsset, MAssetPack, MGame, MPlayer, MPlayerAsset } from '../models';
import type { IAsset, IAssetPack, IPlayerAsset } from '../types';
import { playerService } from './PlayerService';

export const DEFAULT_PACK_ID = 'default';
/** 内置分组：bgm / sfx（音频），food / items / snake / corpse（图片）。可扩展 */
export const ASSET_GROUPS = ['bgm', 'sfx', 'food', 'items', 'snake', 'corpse'] as const;
/** 图片类分组（会被 manifest 预加载） */
export const IMAGE_GROUPS = ['food', 'items', 'snake', 'corpse'] as const;
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
  corpse: 'image',
};

/** 分组默认的资源类型；自定义分组未登记时按图片处理 */
export function kindOfGroup(group: string): 'audio' | 'image' {
  return GROUP_KIND[group] || 'image';
}

/**
 * 玩家可选/装备的外观资源。
 *
 * 判定看**资源行自己的 `equippable` 标记**，不看分组名 ——
 * 服务端不认「贪吃蛇的 snake 分组才是皮肤」，任何游戏的后台资源都能勾成可装备。
 */
export function isSkinAsset(asset: Pick<IAsset, 'group' | 'kind' | 'equippable'>): boolean {
  return asset.equippable === true && asset.kind === 'image';
}

/** 清单里的一条资源（图片分组的 item） */
export interface AssetManifestItem {
  id: string;
  /** 分组名（游戏自定义） */
  group: string;
  key: string;
  label: string;
  /** 展示用主图：皮肤的「身体图」，其他分组就是 url */
  url: string;
  /** 展示用主图（= url） */
  body: string;
  /** 蛇头图；只有配了 meta.head 的皮肤才有 */
  head?: string;
  /** 玩家级可装备（能在设置里勾选装备） */
  equippable: boolean;
  /** 玩家是否有权使用（free 或已授予） */
  owned: boolean;
  /** 是否是当前装备的那一件 */
  equipped: boolean;
}

export interface AssetsManifest {
  game: string;
  /** 缓存键：资源改过就变，加载页据此判断是否刷新缓存 */
  revision: string;
  /** 全部图片 URL：asset_id → 身体图，`<id>:head` → 蛇头图 */
  images: Record<string, string>;
  /** 本游戏的外观资源，按分组下发：group → items */
  groups: Record<string, { items: AssetManifestItem[] }>;
  /** 玩家级可装备的外观（= groups 里 equippable 的汇总） */
  skins: AssetManifestItem[];
  /** 当前玩家装备的蛇身 asset_id（兼容旧客户端） */
  equipped: string;
  /** 按槽位区分的装备：snake=蛇身/蛇头，corpse=死亡残骸 */
  equippedByGroup: Record<string, string>;
  /** 音频：BGM 列表 + 音效表，随清单一次下发 */
  audio: { bgm: { url: string; label: string }[]; sfx: Record<string, string> };
}

/** 挑默认包（包只作存储分组，清单不暴露主题） */
export function pickPack(packs: IAssetPack[], packId?: string): IAssetPack | undefined {
  const wanted = packId ? packs.find(p => p._id === packId) : undefined;
  if (wanted) return wanted;
  return packs.find(p => p.isDefault) || packs.find(p => p._id === DEFAULT_PACK_ID) || packs[0];
}

/**
 * 组装单游戏清单（纯函数，单测直接喂数据）。
 *
 * SB-066：只收 `a.game === game` 的启用行；同 `group:key` 跨包合并时默认包最后写入
 * （优先级最高）。**不再下发 game='' 的通用层，也不返回 pack 字段**。
 */
export function composeManifest(
  packs: IAssetPack[],
  assets: IAsset[],
  options: {
    game: string;
    /** 玩家已装备的蛇身 asset_id */
    equipped?: string;
    /** 玩家已装备的尸体外观 asset_id */
    corpseEquipped?: string;
    /** 玩家额外拥有的 asset_id（`player_assets`） */
    owned?: Set<string>;
  },
): AssetsManifest {
  const game = options.game;
  // 默认包排最后 → 同 key 时覆盖其他包
  const ordered = packs
    .filter(p => p.status !== 0)
    .sort((a, b) => (Number(a.isDefault) - Number(b.isDefault)) || String(a.createdAt).localeCompare(String(b.createdAt)));
  const rows = new Map<string, IAsset>();
  for (const pack of ordered) {
    for (const a of assets) {
      if (a.pack !== pack._id || a.game !== game || a.status === 0) continue;
      rows.set(`${a.group}:${a.key}`, a);
    }
  }

  const images: Record<string, string> = {};
  const bgm: { url: string; label: string }[] = [];
  const sfx: Record<string, string> = {};
  const byGroup = new Map<string, AssetManifestItem[]>();

  for (const a of rows.values()) {
    if (a.kind === 'image') {
      const body = typeof a.meta?.body === 'string' && a.meta.body ? a.meta.body : a.url;
      const head = typeof a.meta?.head === 'string' && a.meta.head ? a.meta.head : '';
      images[a._id] = body;
      if (head) images[`${a._id}:head`] = head;
      const item: AssetManifestItem = {
        id: a._id,
        group: a.group,
        key: a.key,
        label: a.label || a.key,
        url: body,
        body,
        ...(head ? { head } : {}),
        equippable: isSkinAsset(a),
        owned: a.free || !!options.owned?.has(a._id),
        equipped: false,
      };
      const list = byGroup.get(a.group);
      if (list) list.push(item);
      else byGroup.set(a.group, [item]);
    } else if (a.group === 'bgm') {
      bgm.push({ url: a.url, label: a.label || a.key });
    } else if (a.group === 'sfx') {
      sfx[a.key] = a.url;
    }
  }

  const groups: Record<string, { items: AssetManifestItem[] }> = {};
  for (const [group, list] of byGroup) {
    list.sort((x, y) => x.key.localeCompare(y.key));
    groups[group] = { items: list };
  }

  const canEquip = (id?: string, group?: string) => {
    if (!id || !group) return '';
    const item = groups[group]?.items.find(i => i.id === id);
    return item?.equippable && item.owned ? id : '';
  };
  const equippedByGroup: Record<string, string> = {
    snake: canEquip(options.equipped, 'snake'),
    corpse: canEquip(options.corpseEquipped, 'corpse'),
  };
  for (const [group, id] of Object.entries(equippedByGroup)) {
    if (!id) continue;
    const item = groups[group]?.items.find(i => i.id === id);
    if (item) item.equipped = true;
  }

  const skins = Object.values(groups).flatMap(g => g.items.filter(i => i.equippable));
  const stamps = [...rows.values()].map(a => new Date(a.updatedAt || 0).getTime()).filter(t => t > 0);
  const revision = `${game}:${stamps.length ? Math.max(...stamps) : 0}`;

  return {
    game,
    revision,
    images,
    groups,
    skins,
    equipped: equippedByGroup.snake,
    equippedByGroup,
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

/** 该玩家在这个游戏里某类外观的 asset_id */
async function equippedOf(playerId?: string, slot: 'skin' | 'corpse' = 'skin'): Promise<string> {
  if (!playerId) return '';
  const field = slot === 'corpse' ? 'corpse_skin' : 'skin';
  const p = await MPlayer.findById(playerId, { [field]: 1 }).lean(true) as any;
  return p?.[field] ? String(p[field]) : '';
}

/**
 * 组装 manifest（单游戏、无主题包）。
 * @param playerId 玩家 id（`players._id`）：取装备的外观与额外授权；游客传空
 * @param userId   未建角色的玩家可传账号 id 兜底查一次
 */
export async function buildManifest(options: {
  game: string;
  playerId?: string;
  userId?: string;
}): Promise<AssetsManifest> {
  const { packs, assets } = await loadCatalog();
  let pid = options.playerId;
  if (!pid && options.userId) pid = await findPlayerId(options.userId, options.game);
  const [skin, corpse, owned] = await Promise.all([
    equippedOf(pid, 'skin'),
    equippedOf(pid, 'corpse'),
    ownedAssetIds(pid),
  ]);
  const enabled = packs.filter(p => p.status !== 0);
  return composeManifest(enabled, assets, {
    game: options.game, equipped: skin, corpseEquipped: corpse, owned,
  });
}

/** 包列表（后台兼容用；前端清单不再按包切换） */
export async function listPacks(): Promise<IAssetPack[]> {
  return await MAssetPack.find({}).sort({ isDefault: -1, createdAt: 1 }).lean(true) as IAssetPack[];
}

/** 某个包对某个游戏实际生效的音频（兼容旧调用；清单本身不再按包切） */
export async function audioForPack(_packId: string, game: string) {
  const { packs, assets } = await loadCatalog();
  return composeManifest(packs, assets, { game }).audio;
}

/**
 * 玩家装备外观（按 asset_id + slot）。
 * 必须校验：资源存在、是玩家级外观（equippable）、且 free 或已被授予——
 * 否则谁都能穿付费外观，或者把「食物图」当成皮肤装备上去。
 */
export async function equipSkin(
  userId: string,
  game: string,
  assetId: string,
  slot: 'skin' | 'corpse' = 'skin',
): Promise<{ slot: string; asset_id: string }> {
  const asset = await MAsset.findById(String(assetId || '')).lean(true) as IAsset | null;
  if (!asset || asset.status === 0) throw new Error('该外观不存在或已下架');
  if (!isSkinAsset(asset)) throw new Error('该资源不是可装备的外观');
  if (asset.game !== game) throw new Error('该外观不属于这个游戏');

  // 未进过游戏的玩家也会在这里被建出 player 记录：皮肤是玩家级属性，得有承载
  const player = await playerService.getOrCreatePlayer(userId, game);
  if (!asset.free) {
    const owned = await MPlayerAsset.findOne({ player_id: player._id, asset_id: asset._id }).lean(true);
    if (!owned) throw new Error('还没有这个皮肤，先去获得它');
  }
  const field = slot === 'corpse' ? 'corpse_skin' : 'skin';
  await MPlayer.updateOne(
    { _id: player._id },
    { $set: { [field]: asset._id, updatedAt: new Date() } },
  );
  return { slot, asset_id: asset._id };
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
