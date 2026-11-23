import { describe, expect, test } from 'bun:test';
import config from '../src/config';
import { SEED_VOICE_PACKS } from '../src/seed.data';
import {
  canUsePack,
  hasVoicePackPermission,
  resolveGameAudio,
  toPackDTO,
  validateSelection,
} from '../src/services/VoicePackService';

const classic = SEED_VOICE_PACKS.find(p => p._id === 'classic')!;
const ambient = SEED_VOICE_PACKS.find(p => p._id === 'ambient')!;

describe('语音包配置', () => {
  test('种子包含默认包和两个需权限包，配置均为文件 URL', () => {
    expect(classic.isDefault).toBe(true);
    expect(classic.requirePermission).toBe(false);
    for (const pack of SEED_VOICE_PACKS) {
      expect(pack.bgm.length).toBeGreaterThan(0);
      expect(pack.bgm.every(t => t.url.startsWith('/audio/'))).toBe(true);
      expect(Object.values(pack.sfx).every(u => u.startsWith('/audio/'))).toBe(true);
    }
    expect(ambient.requirePermission).toBe(true);
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

  test('toPackDTO 的 hasPermission 是虚拟字段：可枚举、随权限变化、不写入原始数据', () => {
    const guest = toPackDTO(classic, { _id: 'u1', voicePackPerm: false });
    const vip = toPackDTO(ambient, { _id: 'u2', voicePackPerm: true });
    expect(JSON.parse(JSON.stringify(guest)).hasPermission).toBe(true);
    expect(JSON.parse(JSON.stringify(vip)).hasPermission).toBe(true);
    expect(JSON.parse(JSON.stringify(toPackDTO(ambient, null))).hasPermission).toBe(false);
    expect((classic as any).hasPermission).toBeUndefined();
    expect(Object.keys(JSON.parse(JSON.stringify(vip)))).toContain('hasPermission');
  });

  test('validateSelection：无权限 / 停用 / 不存在的包都拒绝', () => {
    expect(validateSelection(classic, null)).toBe(true);
    expect(validateSelection(ambient, { _id: 'u1', voicePackPerm: false })).toBe(false);
    expect(validateSelection(ambient, { _id: 'u2', voicePackPerm: true })).toBe(true);
    expect(validateSelection({ ...ambient, status: 0 }, { _id: 'u2', voicePackPerm: true })).toBe(false);
    expect(validateSelection(null, { _id: 'u2', voicePackPerm: true })).toBe(false);
  });

  test('每套语音包为 7 个游戏各配独立音效，URL 互不相同且指向文件', () => {
    for (const pack of SEED_VOICE_PACKS) {
      const games = pack.games || {};
      expect(Object.keys(games).sort()).toEqual(
        ['2048', 'chess', 'gomoku', 'othello', 'snake', 'tetris', 'xiangqi'],
      );
      const moves = Object.values(games).map(g => g.sfx?.move || '');
      expect(moves.every(url => url.startsWith('/audio/'))).toBe(true);
      expect(new Set(moves).size).toBe(7);
      for (const game of Object.values(games)) {
        expect(game.sfx?.collect).toMatch(/\/audio\/[^/]+\/[^/]+\/collect\.mp3$/);
      }
    }
    // 同一游戏在不同语音包里也是不同音效
    const byGame = (id: string) => SEED_VOICE_PACKS.find(p => p._id === id)!.games!.gomoku.sfx!.move;
    expect(new Set([byGame('classic'), byGame('ambient'), byGame('arcade')]).size).toBe(3);
  });

  test('toPackDTO 原样下发按游戏的配置', () => {
    const dto = JSON.parse(JSON.stringify(toPackDTO(classic, null)));
    expect(dto.games.gomoku.sfx.move).toBe('/audio/classic/gomoku/move.mp3');
    expect(Object.keys(dto.games)).toHaveLength(7);
    expect(dto.sfx.click).toBe('/audio/classic/common/click.mp3');
  });

  test('resolveGameAudio：游戏级 sfx 覆盖包级，bgm 有则覆盖、无则回退', () => {
    const pack = {
      bgm: [{ url: '/common/bgm.mp3' }],
      sfx: { click: '/common/click.mp3', win: '/common/win.mp3', move: '/common/move.mp3' },
      games: {
        gomoku: { sfx: { move: '/gomoku/move.mp3' } },
        snake: { bgm: [{ url: '/snake/bgm.mp3' }], sfx: { collect: '/snake/collect.mp3' } },
      },
    };
    const gomoku = resolveGameAudio(pack, 'gomoku');
    expect(gomoku.sfx.move).toBe('/gomoku/move.mp3');
    expect(gomoku.sfx.click).toBe('/common/click.mp3');
    expect(gomoku.bgm[0].url).toBe('/common/bgm.mp3');
    const snake = resolveGameAudio(pack, 'snake');
    expect(snake.bgm[0].url).toBe('/snake/bgm.mp3');
    expect(snake.sfx.collect).toBe('/snake/collect.mp3');
    expect(snake.sfx.move).toBe('/common/move.mp3');
    expect(resolveGameAudio(pack, 'chess').sfx.move).toBe('/common/move.mp3');
    expect(resolveGameAudio(pack).bgm[0].url).toBe('/common/bgm.mp3');
  });
});
