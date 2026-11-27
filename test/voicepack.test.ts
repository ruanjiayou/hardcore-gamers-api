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

const def = SEED_ASSET_PACKS.find(p => p._id === 'default')!;
/** 权限逻辑仍保留，用一张人工构造的受限包验证（种子里不再有主题包） */
const limited: IAssetPack = { ...def, _id: 'limited', name: '受限', isDefault: false, requirePermission: true };
const rowsOf = (game: string, group: string) =>
  SEED_ASSETS.filter(a => a.game === game && a.group === group);

describe('资源包 · 默认包与权限（兼容保留）', () => {
  test('种子只有一个默认包；素材都指向 /audio 或 /skins', () => {
    expect(SEED_ASSET_PACKS.map(p => p._id)).toEqual(['default']);
    expect(def.isDefault).toBe(true);
    expect(def.requirePermission).toBe(false);
    expect((def as any).bgm).toBeUndefined();
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

  test('默认包人人可用；受限包仅授权用户可用', () => {
    const guest = { _id: 'u1', voicePackPerm: false };
    const vip = { _id: 'u2', voicePackPerm: true };
    expect(canUsePack(def, guest)).toBe(true);
    expect(canUsePack(def, null)).toBe(true);
    expect(canUsePack(limited, guest)).toBe(false);
    expect(canUsePack(limited, vip)).toBe(true);
  });

  test('toPackDTO 只下发包元信息（不再带 bgm/sfx/games）', () => {
    const guest = toPackDTO(def as IAssetPack, { _id: 'u1', voicePackPerm: false });
    const vip = toPackDTO(limited as IAssetPack, { _id: 'u2', voicePackPerm: true });
    expect(JSON.parse(JSON.stringify(guest)).hasPermission).toBe(true);
    expect(JSON.parse(JSON.stringify(vip)).hasPermission).toBe(true);
    expect(JSON.parse(JSON.stringify(toPackDTO(limited as IAssetPack, null))).hasPermission).toBe(false);
    expect(Object.keys(guest)).not.toContain('games');
    expect(Object.keys(guest)).not.toContain('sfx');
  });

  test('validateSelection：无权限 / 停用 / 不存在的包都拒绝', () => {
    expect(validateSelection(def as IAssetPack, null)).toBe(true);
    expect(validateSelection(limited as IAssetPack, { _id: 'u1', voicePackPerm: false })).toBe(false);
    expect(validateSelection(limited as IAssetPack, { _id: 'u2', voicePackPerm: true })).toBe(true);
    expect(validateSelection({ ...limited, status: 0 } as IAssetPack, { _id: 'u2', voicePackPerm: true })).toBe(false);
    expect(validateSelection(null, { _id: 'u2', voicePackPerm: true })).toBe(false);
  });
});

describe('资源 · 每个游戏各配一份（无通用层）', () => {
  const games = ['2048', 'chess', 'gomoku', 'othello', 'snake', 'tetris', 'xiangqi'];

  test('7 个游戏各有 click/move/collect/win/lose，URL 互不相同', () => {
    for (const game of games) {
      expect(rowsOf(game, 'sfx').map(r => r.key).sort())
        .toEqual(['click', 'collect', 'lose', 'move', 'win']);
      rowsOf(game, 'sfx').forEach(r => expect(r.url).toContain(`/${game}/`));
    }
    const moves = games.map(g => rowsOf(g, 'sfx').find(r => r.key === 'move')!.url);
    expect(new Set(moves).size).toBe(7);
  });

  test('没有 game="" 的通用层资源', () => {
    expect(SEED_ASSETS.some(a => a.game === '')).toBe(false);
  });

  test('每个游戏都有自己的一行 BGM', () => {
    for (const game of games) {
      expect(rowsOf(game, 'bgm').map(r => r.key)).toEqual(['main']);
    }
  });

  test('贪吃蛇图片按组齐全，皮肤有头/身两张图，尸体可装备', () => {
    expect(rowsOf('snake', 'food').map(r => r.key).sort()).toEqual(['big', 'mid', 'small']);
    expect(rowsOf('snake', 'items').map(r => r.key).sort()).toEqual(['magnet', 'star']);
    const skins = rowsOf('snake', 'snake');
    expect(skins.map(r => r.key).sort()).toEqual(['candy', 'default', 'neon']);
    expect(skins.every(r => r.equippable && r.meta?.head && r.meta?.body)).toBe(true);
    expect(rowsOf('snake', 'corpse').every(r => r.equippable)).toBe(true);
  });

  test('只有蛇皮肤与尸体标了玩家级可装备', () => {
    const equippable = SEED_ASSETS.filter((a: IAsset) => a.equippable);
    expect(new Set(equippable.map(a => a.group))).toEqual(new Set(['snake', 'corpse']));
    expect(equippable.every(a => a.game === 'snake')).toBe(true);
  });

  test('资源 _id 确定且唯一', () => {
    const ids = SEED_ASSETS.map(a => a._id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toContain('default_snake_snake_neon');
    expect(ids).toContain('default_gomoku_sfx_move');
  });
});
