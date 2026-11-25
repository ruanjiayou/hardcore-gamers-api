import { describe, expect, test } from 'bun:test';
import { SEED_ASSETS, SEED_ASSET_PACKS, SEED_TIME } from '../src/seed.data';
import { composeManifest, planRevoke } from '../src/services/AssetsService';
import type { IAsset, IAssetPack } from '../src/types';

const packs = SEED_ASSET_PACKS as IAssetPack[];
const assets = SEED_ASSETS as IAsset[];

const snake = (packId?: string, extra?: Partial<Parameters<typeof composeManifest>[2]>) =>
  composeManifest(packs, assets, { game: 'snake', packId, ...extra });

describe('资源清单 manifest', () => {
  test('默认包：图片按 asset_id 索引，食物/道具给 id 索引', () => {
    const m = snake();
    expect(m.pack).toBe('classic');
    // classic 没有图片素材 → 全部为空，客户端回退矢量绘制（不能报错）
    expect(m.images).toEqual({});
    expect(m.food).toEqual({});
    expect(m.items).toEqual({});
    expect(m.skins).toEqual([]);
  });

  test('街机包：图片、食物三档、道具、蛇皮肤都在，且值都是 assets._id', () => {
    const m = snake('arcade');
    expect(m.pack).toBe('arcade');
    expect(Object.keys(m.images).sort()).toEqual([
      'arcade_snake_food_big', 'arcade_snake_food_mid', 'arcade_snake_food_small',
      'arcade_snake_items_magnet', 'arcade_snake_items_star',
      'arcade_snake_snake_candy', 'arcade_snake_snake_default', 'arcade_snake_snake_neon',
    ]);
    expect(m.food).toEqual({
      small: 'arcade_snake_food_small',
      mid: 'arcade_snake_food_mid',
      big: 'arcade_snake_food_big',
    });
    expect(m.items).toEqual({ magnet: 'arcade_snake_items_magnet', star: 'arcade_snake_items_star' });
    expect(m.skins.map(s => s.key)).toEqual(['default', 'neon', 'candy']);
    // 图片 URL 只出现在预加载清单里，且 key 是 id 不是 key
    expect(m.images['arcade_snake_snake_neon']).toBe('/skins/arcade/snake/snake/neon.svg');
  });

  test('音频按游戏生效：游戏级 sfx 覆盖包级，bgm 沿用包级', () => {
    const m = snake('classic');
    expect(m.audio.sfx.collect).toBe('/audio/classic/snake/collect.mp3');
    expect(m.audio.sfx.click).toBe('/audio/classic/common/click.mp3');
    expect(m.audio.bgm).toHaveLength(1);
    expect(m.audio.bgm[0].url).toBe('/audio/classic/common/bgm.mp3');
    // 不同游戏的音效互不相同
    const gomoku = composeManifest(packs, assets, { game: 'gomoku', packId: 'classic' });
    expect(gomoku.audio.sfx.collect).toBe('/audio/classic/gomoku/collect.mp3');
  });

  test('不同游戏互不共用资源：棋类拿不到贪吃蛇的皮肤图', () => {
    const gomoku = composeManifest(packs, assets, { game: 'gomoku', packId: 'arcade' });
    expect(gomoku.images).toEqual({});
    expect(gomoku.skins).toEqual([]);
  });

  test('多层回退：选中包缺图时用默认包的图垫底', () => {
    // 造一个「只改了食物 small」的包，其余图应从默认包补
    const base = packs.map(p => ({ ...p }));
    const ownAssets: IAsset[] = [
      ...assets,
      {
        _id: 'arcade2_snake_food_small', pack: 'arcade2', game: 'snake', group: 'food', key: 'small',
        label: '小果', kind: 'image', url: '/x/small.svg', meta: {}, free: true, status: 1, order: 0,
        createdAt: SEED_TIME, updatedAt: SEED_TIME,
      },
      // 默认包里放一张 mid，验证「选中的包没有 → 从默认包取」
      {
        _id: 'classic_snake_food_mid', pack: 'classic', game: 'snake', group: 'food', key: 'mid',
        label: '中果', kind: 'image', url: '/x/mid.svg', meta: {}, free: true, status: 1, order: 0,
        createdAt: SEED_TIME, updatedAt: SEED_TIME,
      },
    ];
    const m = composeManifest([...base, { ...packs[0], _id: 'arcade2', isDefault: false, name: 'x' }], ownAssets, {
      game: 'snake', packId: 'arcade2',
    });
    expect(m.images['arcade2_snake_food_small']).toBe('/x/small.svg');
    expect(m.images['classic_snake_food_mid']).toBe('/x/mid.svg');
    expect(m.food).toEqual({ small: 'arcade2_snake_food_small', mid: 'classic_snake_food_mid' });
  });

  test('下架的资源不参与清单', () => {
    const off = assets.map(a => (a._id === 'arcade_snake_snake_neon' ? { ...a, status: 0 } : a));
    const m = composeManifest(packs, off, { game: 'snake', packId: 'arcade' });
    expect(m.images['arcade_snake_snake_neon']).toBeUndefined();
    expect(m.skins.map(s => s.key)).not.toContain('neon');
  });

  test('授权：free=false 的皮肤默认 owned=false，授予后 owned=true 才能装备', () => {
    const paid = assets.map(a => (a._id === 'arcade_snake_snake_candy' ? { ...a, free: false } : a));
    const guest = composeManifest(packs, paid, { game: 'snake', packId: 'arcade' });
    const candy = guest.skins.find(s => s.key === 'candy')!;
    expect(candy.owned).toBe(false);

    const owner = composeManifest(packs, paid, {
      game: 'snake', packId: 'arcade', owned: new Set(['arcade_snake_snake_candy']),
    });
    expect(owner.skins.find(s => s.key === 'candy')!.owned).toBe(true);
  });

  test('equipped 只认清单里存在的皮肤，否则为空', () => {
    const m = snake('arcade', { equipped: 'arcade_snake_snake_neon' });
    expect(m.equipped).toBe('arcade_snake_snake_neon');
    expect(m.skins.find(s => s.key === 'neon')!.equipped).toBe(true);
    // 换到没有这张图的包：装备值失效，不能把不存在的皮肤下发出去
    const classic = snake('classic', { equipped: 'arcade_snake_snake_neon' });
    expect(classic.equipped).toBe('');
  });

  test('revision 随资源更新时间变化（只改图不改包也会失效缓存）', () => {
    const before = snake('arcade').revision;
    const touched = assets.map(a =>
      a._id === 'arcade_snake_food_small' ? { ...a, updatedAt: new Date(SEED_TIME.getTime() + 60_000) } : a);
    expect(composeManifest(packs, touched, { game: 'snake', packId: 'arcade' }).revision).not.toBe(before);
  });

  test('未知/停用的包回退默认包', () => {
    expect(snake('nope').pack).toBe('classic');
    const disabled = packs.map(p => (p._id === 'arcade' ? { ...p, status: 0 } : p));
    // 停用的包不会被传进来（调用方已过滤），但即便传进来 pickPack 仍能选中它 —— 这里断言过滤后的行为
    const enabled = disabled.filter(p => p.status !== 0);
    expect(composeManifest(enabled, assets, { game: 'snake', packId: 'arcade' }).pack).toBe('classic');
  });
});

describe('资源授权与撤权', () => {
  test('撤权只删这一条授权', () => {
    const plan = planRevoke('p1', 'a1');
    expect(plan.deleteGrant).toEqual({ player_id: 'p1', asset_id: 'a1' });
  });

  test('撤权同时卸下皮肤，且不会误卸玩家装备的其它皮肤', () => {
    const plan = planRevoke('p1', 'a1');
    // 过滤条件必须同时命中 _id 和 skin：少了 skin 会把 p1 装备的别的皮肤也清空
    expect(plan.unloadSkin).toEqual({ _id: 'p1', skin: 'a1' });
    // 换个玩家/资源就不匹配 → 不会误伤
    expect(plan.unloadSkin.skin === 'a2').toBe(false);
  });

  test('撤权后 manifest 不再下发这个皮肤（owned 消失 → equipped 清空）', () => {
    const paid = assets.map(a => (a._id === 'arcade_snake_snake_candy' ? { ...a, free: false } : a));
    const owned = new Set(['arcade_snake_snake_candy']);
    const before = composeManifest(packs, paid, {
      game: 'snake', packId: 'arcade', equipped: 'arcade_snake_snake_candy', owned,
    });
    expect(before.equipped).toBe('arcade_snake_snake_candy');

    // 撤权 = 授权记录被删 → owned 集合里没有它了
    const after = composeManifest(packs, paid, {
      game: 'snake', packId: 'arcade', equipped: 'arcade_snake_snake_candy', owned: new Set(),
    });
    expect(after.equipped).toBe('');
    expect(after.skins.find(s => s.key === 'candy')!.owned).toBe(false);
    expect(after.skins.find(s => s.key === 'candy')!.equipped).toBe(false);
  });

  test('free=true 的资源永远可用，不受授权表影响', () => {
    const m = composeManifest(packs, assets, {
      game: 'snake', packId: 'arcade', equipped: 'arcade_snake_snake_neon', owned: new Set(),
    });
    expect(m.equipped).toBe('arcade_snake_snake_neon');
  });
});
