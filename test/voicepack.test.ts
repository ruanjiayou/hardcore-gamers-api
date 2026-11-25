import { describe, expect, test } from 'bun:test';
import config from '../src/config';
import { SEED_ASSETS, SEED_ASSET_PACKS } from '../src/seed.data';
import {
  canUsePack,
  hasVoicePackPermission,
  toPackDTO,
  validateSelection,
} from '../src/services/VoicePackService';
import type { IAsset, IAssetPack } from '../src/types';

const classic = SEED_ASSET_PACKS.find(p => p._id === 'classic')!;
const ambient = SEED_ASSET_PACKS.find(p => p._id === 'ambient')!;
const rowsOf = (pack: string, game: string, group: string) =>
  SEED_ASSETS.filter(a => a.pack === pack && a.game === game && a.group === group);

describe('资源包 · 包元信息与权限', () => {
  test('种子：一个默认包 + 两个需权限包，素材都指向 /audio 或 /skins', () => {
    expect(SEED_ASSET_PACKS.map(p => p._id).sort()).toEqual(['ambient', 'arcade', 'classic']);
    expect(classic.isDefault).toBe(true);
    expect(classic.requirePermission).toBe(false);
    expect(ambient.requirePermission).toBe(true);
    // 资源明细都在 assets 行里，包本身不再挂 bgm/sfx 对象
    expect((classic as any).bgm).toBeUndefined();
    for (const a of SEED_ASSETS) {
      expect(a.url.startsWith('/audio/') || a.url.startsWith('/skins/')).toBe(true);
      expect(a.kind).toBe(a.group === 'bgm' || a.group === 'sfx' ? 'audio' : 'image');
    }
  });

  test('hasVoicePackPermission 是计算值：无权限位 false，置位 true', () => {
    expect(hasVoicePackPermission(null)).toBe(false);
    expect(hasVoicePackPermission({ _id: 'u1', voicePackPerm: false })).toBe(false);
    expect(hasVoicePackPermission({ _id: 'u1', voicePackPerm: true })).toBe(true);
  });

  test('etcd 白名单里的用户也视为有权限', () => {
    const original = config.voice_pack_allowlist;
    config.voice_pack_allowlist = ['u2'];
    try {
      expect(hasVoicePackPermission({ _id: 'u1' })).toBe(false);
      expect(hasVoicePackPermission({ _id: 'u2' })).toBe(true);
    } finally {
      config.voice_pack_allowlist = original;
    }
  });

  test('默认包人人可用；需权限包仅授权用户可用', () => {
    const guest = { _id: 'u1', voicePackPerm: false };
    const vip = { _id: 'u2', voicePackPerm: true };
    expect(canUsePack(classic, guest)).toBe(true);
    expect(canUsePack(classic, null)).toBe(true);
    expect(canUsePack(ambient, guest)).toBe(false);
    expect(canUsePack(ambient, vip)).toBe(true);
  });

  test('toPackDTO 只下发包元信息（不再带 bgm/sfx/games）', () => {
    const guest = toPackDTO(classic as IAssetPack, { _id: 'u1', voicePackPerm: false });
    const vip = toPackDTO(ambient as IAssetPack, { _id: 'u2', voicePackPerm: true });
    expect(JSON.parse(JSON.stringify(guest)).hasPermission).toBe(true);
    expect(JSON.parse(JSON.stringify(vip)).hasPermission).toBe(true);
    expect(JSON.parse(JSON.stringify(toPackDTO(ambient as IAssetPack, null))).hasPermission).toBe(false);
    expect(Object.keys(guest)).not.toContain('games');
    expect(Object.keys(guest)).not.toContain('sfx');
  });

  test('validateSelection：无权限 / 停用 / 不存在的包都拒绝', () => {
    expect(validateSelection(classic as IAssetPack, null)).toBe(true);
    expect(validateSelection(ambient as IAssetPack, { _id: 'u1', voicePackPerm: false })).toBe(false);
    expect(validateSelection(ambient as IAssetPack, { _id: 'u2', voicePackPerm: true })).toBe(true);
    expect(validateSelection({ ...ambient, status: 0 } as IAssetPack, { _id: 'u2', voicePackPerm: true })).toBe(false);
    expect(validateSelection(null, { _id: 'u2', voicePackPerm: true })).toBe(false);
  });
});

describe('资源包 · 音效按游戏各自独立', () => {
  const games = ['2048', 'chess', 'gomoku', 'othello', 'snake', 'tetris', 'xiangqi'];

  test('每个包为 7 个游戏各配 move/collect，且 URL 互不相同', () => {
    for (const pack of SEED_ASSET_PACKS) {
      for (const game of games) {
        const rows = rowsOf(pack._id, game, 'sfx');
        expect(rows.map(r => r.key).sort()).toEqual(['collect', 'move']);
        rows.forEach(r => expect(r.url).toMatch(/\/audio\/[^/]+\/[^/]+\/(move|collect)\.mp3$/));
      }
      const moves = games.map(g => rowsOf(pack._id, g, 'sfx').find(r => r.key === 'move')!.url);
      expect(new Set(moves).size).toBe(7);
    }
    // 同一游戏在不同包里也是不同音效：不可能所有游戏/主题共用一份
    const mv = (pack: string) => rowsOf(pack, 'gomoku', 'sfx').find(r => r.key === 'move')!.url;
    expect(new Set([mv('classic'), mv('ambient'), mv('arcade')]).size).toBe(3);
  });

  test('包级通用音效 click/win/lose 用 game="" 表示', () => {
    for (const pack of SEED_ASSET_PACKS) {
      expect(rowsOf(pack._id, '', 'sfx').map(r => r.key).sort()).toEqual(['click', 'lose', 'win']);
    }
  });

  test('BGM 也是每个游戏各配一份，可以多首：ambient 配了两首，key 不同', () => {
    // 通用层（game=''）没有 BGM —— 通用包只留 UI 通用音
    for (const pack of SEED_ASSET_PACKS) {
      expect(rowsOf(pack._id, '', 'bgm')).toHaveLength(0);
    }
    // 每个游戏都有自己的一行 BGM，ambient 还能配两首
    for (const game of games) {
      expect(rowsOf('ambient', game, 'bgm').map(r => r.key)).toEqual(['main', 'secondary']);
      expect(rowsOf('classic', game, 'bgm')).toHaveLength(1);
    }
  });

  test('街机主题带贪吃蛇的皮肤图，其余主题不带（客户端回退矢量）', () => {
    expect(rowsOf('arcade', 'snake', 'food').map(r => r.key).sort()).toEqual(['big', 'mid', 'small']);
    expect(rowsOf('arcade', 'snake', 'items').map(r => r.key).sort()).toEqual(['magnet', 'star']);
    expect(rowsOf('arcade', 'snake', 'snake').map(r => r.key).sort()).toEqual(['candy', 'default', 'neon']);
    for (const pack of ['classic', 'ambient']) {
      const images = SEED_ASSETS.filter((a: IAsset) => a.pack === pack && a.kind === 'image');
      expect(images).toHaveLength(0);
    }
  });

  test('只有蛇皮肤标了「玩家级可装备」，食物/道具是主题资源', () => {
    const equippable = SEED_ASSETS.filter((a: IAsset) => a.equippable);
    expect(new Set(equippable.map(a => a.group))).toEqual(new Set(['snake']));
    expect(equippable.every(a => a.game === 'snake')).toBe(true);
  });

  test('资源 _id 确定且唯一：种子重复运行不会换 id（player/match 引用不会悬空）', () => {
    const ids = SEED_ASSETS.map(a => a._id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toContain('arcade_snake_snake_neon');
    expect(ids).toContain('classic_gomoku_sfx_move');
  });
});
