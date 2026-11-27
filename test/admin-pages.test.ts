import { describe, expect, test } from 'bun:test';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = join(import.meta.dir, '../../admin');
const read = (rel: string) => readFileSync(join(ROOT, rel), 'utf8');
const compact = (s: string) => s.replace(/\s+/g, '');

describe('ADMIN-013 管理端页面拆分', () => {
  const pages = ['Login', 'GamesTab', 'RobotsTab', 'AssetsTab', 'RoomsTab', 'Overview'];

  test('每个页面独立成文件', () => {
    for (const name of pages) {
      const file = `src/components/${name}.tsx`;
      expect(existsSync(join(ROOT, file)), file).toBe(true);
      expect(read(file)).toContain(`export default function ${name}`);
    }
    expect(existsSync(join(ROOT, 'src/types.ts'))).toBe(true);
  });

  test('main.tsx 只是外壳，不再内嵌页面实现', () => {
    const main = compact(read('src/main.tsx'));
    for (const name of pages) expect(main).toContain(`from'./components/${name}'`);
    for (const name of pages) expect(main).not.toContain(`function${name}(`);
    expect(main).not.toContain('functionGameForm(');
    expect(read('src/main.tsx').split('\n').length).toBeLessThan(100);
  });

  test('共享类型和常量集中到 types.ts', () => {
    const types = read('src/types.ts');
    expect(types).toContain('export type Notify');
    expect(types).toContain('export interface Game');
    expect(types).toContain('export interface AssetDraft');
  });
});

describe('ADMIN-013 资源页按游戏分选项卡', () => {
  test('资源页不再有资源包选择器与 /packs 请求', () => {
    const tsx = compact(read('src/components/AssetsTab.tsx'));
    expect(tsx).not.toContain("'/packs'");
    expect(tsx).not.toContain('<selectvalue={packId}');
    expect(tsx).not.toContain('<h2>资源包</h2>');
  });

  test('游戏用选项卡切换，key 用下拉框', () => {
    const tsx = compact(read('src/components/AssetsTab.tsx'));
    const types = compact(read('src/types.ts'));
    expect(tsx).toContain('game-tabs');
    expect(tsx).toContain('games.map(');
    expect(tsx).toContain('<selectvalue={draft.key}');
    expect(types).toContain('food:{');
    expect(types).toContain("items:{label:'道具',kind:'image',keys:['magnet','star']");
  });

  test('资源类型语义：食物/道具不可装备，皮肤/尸体可装备', () => {
    const tsx = compact(read('src/components/AssetsTab.tsx'));
    const types = compact(read('src/types.ts'));
    expect(types).toContain("snake:{label:'蛇皮肤',kind:'image',keys:['default','neon','candy'],equippable:true}");
    expect(types).toContain("corpse:{label:'死亡残骸',kind:'image',keys:['default'],equippable:true}");
    expect(types).toContain("food:{label:'食物',kind:'image',keys:['small','mid','big'],equippable:false}");
    expect(tsx).toContain('meta?.head');
  });
});
