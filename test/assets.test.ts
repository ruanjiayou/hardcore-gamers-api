import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { SEED_ASSETS, SEED_ASSET_PACKS, SEED_TIME } from '../src/seed.data';
import { composeManifest, planRevoke } from '../src/services/AssetsService';
import type { IAsset, IAssetPack } from '../src/types';

const packs = SEED_ASSET_PACKS as IAssetPack[];
const assets = SEED_ASSETS as IAsset[];
const ROOT = join(import.meta.dir, '..');
const read = (rel: string) => readFileSync(join(ROOT, rel), 'utf8');

const snake = (extra?: Partial<Parameters<typeof composeManifest>[2]>) =>
  composeManifest(packs, assets, { game: 'snake', ...extra });

describe('SB-066 资源清单只含单个游戏', () => {
  test('路由把游戏名放在 path 上，不再从 query 取 game/pack', () => {
    const ts = read('src/controller/assets.ts');
    expect(ts).toContain("router.get('/:game/manifest.json'");
    expect(ts).toContain('req.params.game');
    expect(ts).not.toContain("router.get('/manifest.json'");
  });

  test('清单没有 pack 字段，只包含该游戏的资源分组', () => {
    const m = snake();
    expect((m as any).pack).toBeUndefined();
    expect(Object.keys(m.groups).sort()).toEqual(['corpse', 'food', 'items', 'snake']);
    expect(Object.values(m.images).every(url => url.includes('/snake/'))).toBe(true);
    expect(m.revision.startsWith('snake:')).toBe(true);
  });

  test('UI 通用音按游戏各配一行：清单里有 click/win/lose，没有 game="" 的残留', () => {
    const m = snake();
    for (const key of ['click', 'move', 'collect', 'win', 'lose']) {
      expect(m.audio.sfx[key]).toBeTruthy();
      expect(m.audio.sfx[key]).toContain('/snake/');
    }
    expect(assets.some(a => a.game === '' && a.group === 'sfx')).toBe(false);
    const gomoku = composeManifest(packs, assets, { game: 'gomoku' });
    expect(gomoku.audio.sfx.collect).toContain('/gomoku/');
    expect(gomoku.groups.snake).toBeUndefined();
    expect(gomoku.images).toEqual({});
  });

  test('种子只有一个默认包，不再有经典/深空/街机主题', () => {
    expect(packs.map(p => p._id)).toEqual(['default']);
    expect(assets.every(a => a.pack === 'default')).toBe(true);
  });
});

describe('SB-066 蛇皮肤头/身与尸体外观', () => {
  test('皮肤带 body/head 两张 URL；展示用 body，预加载两张都收', () => {
    const m = snake();
    const skin = m.groups.snake.items.find(i => i.key === 'default')!;
    expect(skin.body).toContain('snake/default-body.svg');
    expect(skin.head).toContain('snake/default-head.svg');
    expect(m.images[skin.id]).toBe(skin.body);
    expect(m.images[`${skin.id}:head`]).toBe(skin.head);
    expect(skin.url).toBe(skin.body);
  });

  test('食物与道具不可装备；蛇皮肤与尸体可装备', () => {
    const m = snake();
    expect(m.groups.food.items.every(i => !i.equippable)).toBe(true);
    expect(m.groups.items.items.every(i => !i.equippable)).toBe(true);
    expect(m.groups.snake.items.every(i => i.equippable)).toBe(true);
    expect(m.groups.corpse.items.every(i => i.equippable)).toBe(true);
    expect(new Set(m.skins.map(s => s.group))).toEqual(new Set(['corpse', 'snake']));
  });

  test('蛇身与尸体分别装备，equippedByGroup 各写各的', () => {
    const skinId = 'default_snake_snake_default';
    const corpseId = 'default_snake_corpse_default';
    const m = snake({ equipped: skinId, corpseEquipped: corpseId });
    expect(m.equipped).toBe(skinId);
    expect(m.equippedByGroup).toEqual({ snake: skinId, corpse: corpseId });
    expect(m.groups.corpse.items.find(i => i.id === corpseId)!.equipped).toBe(true);
    expect(m.groups.snake.items.find(i => i.id === skinId)!.equipped).toBe(true);
  });

  test('装备槽写入不同 player 字段', () => {
    const ts = read('src/services/AssetsService.ts');
    expect(ts).toContain("slot === 'corpse' ? 'corpse_skin' : 'skin'");
  });
});

describe('资源授权与缓存失效', () => {
  test('free=false 的皮肤默认 owned=false，授予后 owned=true 才能装备', () => {
    const paid = assets.map(a => (a._id === 'default_snake_snake_candy' ? { ...a, free: false } : a));
    const guest = composeManifest(packs, paid, { game: 'snake' });
    expect(guest.skins.find(s => s.key === 'candy')!.owned).toBe(false);
    const owner = composeManifest(packs, paid, {
      game: 'snake', owned: new Set(['default_snake_snake_candy']),
    });
    expect(owner.skins.find(s => s.key === 'candy')!.owned).toBe(true);
  });

  test('equipped 只认清单里存在且有权限的皮肤，否则为空', () => {
    const paid = assets.map(a => (a._id === 'default_snake_snake_candy' ? { ...a, free: false } : a));
    const m = composeManifest(packs, paid, {
      game: 'snake', equipped: 'default_snake_snake_candy', owned: new Set(),
    });
    expect(m.equipped).toBe('');
    expect(m.equippedByGroup.snake).toBe('');
  });

  test('revision 随资源更新时间变化', () => {
    const before = snake().revision;
    const touched = assets.map(a =>
      a._id === 'default_snake_food_small' ? { ...a, updatedAt: new Date(SEED_TIME.getTime() + 60_000) } : a);
    expect(composeManifest(packs, touched, { game: 'snake' }).revision).not.toBe(before);
  });

  test('下架的资源不参与清单', () => {
    const off = assets.map(a => (a._id === 'default_snake_snake_neon' ? { ...a, status: 0 } : a));
    expect(composeManifest(packs, off, { game: 'snake' }).images['default_snake_snake_neon']).toBeUndefined();
  });

  test('撤权只删这一条授权，并只卸下正装备的这件外观', () => {
    const plan = planRevoke('p1', 'a1');
    expect(plan.deleteGrant).toEqual({ player_id: 'p1', asset_id: 'a1' });
    expect(plan.unloadSkin).toEqual({ _id: 'p1', skin: 'a1' });
  });

  test('后台新建资源不传 pack 时服务端写默认包', () => {
    const ts = read('src/controller/admin.ts');
    expect(ts).toContain('existing?.pack ?? DEFAULT_PACK_ID');
  });
});
