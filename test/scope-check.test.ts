/**
 * 静态检查：捕捉「引用了作用域外变量」这类**只有运行时才炸**的错误。
 *
 * 背景（`SB-054`）：`enterArena` 里加 skin 参数时误写了 `(player as any).skin`，
 * 而 `player` 并不在该函数作用域内 → 运行时 `ReferenceError: player is not defined`。
 * 这个错误被 `try/catch` 吞掉，只在日志里留一行「无尽竞技房开局失败」，
 * 表现是「玩家进了房间但对局永远不开」。
 *
 * server 没有 tsconfig，`bun build` 也不做类型检查 → 这类错误只能靠扫描兜住。
 */
import { describe, expect, test } from 'bun:test';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const SRC = join(import.meta.dir, '../src');

/** 收集目录下的 .ts 文件 */
function tsFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, name.name);
    if (name.isDirectory()) out.push(...tsFiles(p));
    else if (name.name.endsWith('.ts')) out.push(p);
  }
  return out;
}

/**
 * 取出一个函数的**签名部分**（从 `function name(` 到参数列表结束的 `)`）。
 */
function extractSignature(src: string, name: string): string {
  const idx = src.search(new RegExp(`(?:async\\s+)?function\\s+${name}\\s*\\(`));
  if (idx < 0) return '';
  const open = src.indexOf('(', idx);
  if (open < 0) return '';
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    if (src[i] === '(') depth++;
    else if (src[i] === ')') {
      depth--;
      if (depth === 0) return src.slice(open, i + 1);
    }
  }
  return '';
}

/**
 * 取出一个函数的源码块（大括号配平）。
 * 只处理函数体里不含字符串字面量大括号的情况 —— 足够覆盖本仓库的 handler。
 */
function extractFunction(src: string, name: string): string {
  const idx = src.search(new RegExp(`(?:async\\s+)?function\\s+${name}\\s*\\(`));
  if (idx < 0) return '';
  const open = src.indexOf('{', idx);
  if (open < 0) return '';
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') {
      depth--;
      if (depth === 0) return src.slice(open, i + 1);
    }
  }
  return '';
}

/**
 * 取出一个函数的形参名。
 * 形参可能带类型标注（`room: any`）与默认值（`nickname?: string`），
 * 所以不能只按「标识符 + 逗号」匹配 —— 要允许中间出现 `: 类型` / `?` / `=`。
 */
function paramNames(sig: string): string[] {
  // 去掉括号，只留参数列表内容
  const open = sig.indexOf('(');
  const close = sig.lastIndexOf(')');
  if (open < 0 || close < 0) return [];
  const inner = sig.slice(open + 1, close);
  const out: string[] = [];
  let depth = 0;
  let cur = '';
  for (const ch of inner) {
    if ('({[<'.includes(ch)) depth++;
    if (')}]>]'.includes(ch)) depth--;
    if (ch === ',' && depth === 0) { out.push(cur); cur = ''; continue; }
    cur += ch;
  }
  if (cur.trim()) out.push(cur);
  return out
    .map(p => p.split(':')[0].split('=')[0].replace(/^\.\.\./, '').trim())
    .filter(Boolean);
}

/**
 * 剥离字符串字面量与注释，避免把 `'room:game-start'` 里的 game 当成变量引用。
 */
function stripLiterals(src: string): string {
  return src
    // 行注释
    .replace(/\/\/[^\n]*/g, ' ')
    // 块注释
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    // 模板字符串（先整体挖掉，避免内部 ${} 干扰）
    .replace(/`(?:[^`\\]|\\.)*`/g, ' ')
    // 单引号 / 双引号字符串
    .replace(/'(?:[^'\\\n]|\\.)*'/g, ' ')
    .replace(/"(?:[^"\\\n]|\\.)*"/g, ' ');
}

/** 已知的、可在函数内自由引用的外层符号 */
const ALLOWED = new Set([
  // 模块导入
  'MRoom', 'MPlayer', 'MGame', 'MUser',
  'gameService', 'roomService', 'playerService', 'userService', 'snakeRuntimeService',
  'constant', 'MemberType', 'isSoloGame',
  // 模块级局部变量（setupLobbyHandlers 的形参与闭包变量）
  'socket', 'io', 'user_id', 'isLoggedIn', 'isGuest',
  // 内建
  'console', 'Math', 'Number', 'String', 'Boolean', 'Array', 'Object', 'JSON', 'Date',
  'Set', 'Map', 'Promise', 'Error', 'parseInt', 'parseFloat', 'isNaN', 'isFinite',
  'undefined', 'null', 'true', 'false', 'void', 'this', 'arguments',
  'Buffer', 'process', 'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval',
  'URL', 'URLSearchParams', 'TextEncoder', 'TextDecoder',
]);

/** 关键字，不算「变量引用」 */
const KEYWORDS = new Set([
  'if', 'else', 'for', 'while', 'return', 'try', 'catch', 'finally', 'await', 'async',
  'function', 'new', 'typeof', 'instanceof', 'in', 'of', 'const', 'let', 'var', 'throw',
  'switch', 'case', 'break', 'continue', 'default', 'delete', 'void', 'yield',
  'static', 'get', 'set', 'class', 'extends', 'super', 'this', 'as', 'from',
]);

describe('作用域外变量引用（静态扫描）', () => {
  test('enterArena 不引用作用域外的 player', () => {
    const src = readFileSync(join(SRC, 'handlers/LobbyHandler.ts'), 'utf-8');
    const raw = extractFunction(src, 'enterArena');
    expect(raw.length).toBeGreaterThan(0);
    const body = stripLiterals(raw);

    // 收集函数体内出现的标识符
    const ids = new Set<string>();
    const re = /(?<![.\w$])([A-Za-z_$][\w$]*)/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(body))) ids.add(m[1]);

    // 允许：函数自己的形参、本地 const/let/var、catch 参数、解构变量
    const local = new Set<string>();
    const declRe = /\b(?:const|let|var)\s+([\w$]+)/g;
    while ((m = declRe.exec(body))) local.add(m[1]);
    for (const p of paramNames(extractSignature(src, 'enterArena'))) local.add(p);
    for (const cm of body.matchAll(/catch\s*\(\s*([\w$]+)/g)) local.add(cm[1]);
    for (const dm of body.matchAll(/\b(?:const|let|var)\s*\{([^}]*)\}/g)) {
      for (const part of dm[1].split(',')) {
        const name = part.split(':').pop()?.trim().replace(/^\.\.\./, '');
        if (name) local.add(name);
      }
    }

    const suspects = [...ids].filter(
      id => !ALLOWED.has(id) && !local.has(id) && !KEYWORDS.has(id),
    );

    // 关键断言：player 不该出现在这里（它是 matchRoom 的局部变量）
    expect(suspects).not.toContain('player');
  });

  test('scan：所有 handler 里没有裸的未声明变量引用', () => {
    // 只做针对性检查：已知踩过坑的变量名
    const KNOWN_GOTCHAS = ['player', 'room', 'game'];
    const problems: string[] = [];

    for (const file of tsFiles(SRC)) {
      const src = readFileSync(file, 'utf-8');
      for (const fn of ['enterArena', 'matchRoom', 'joinRoom', 'createRoom']) {
        const body = stripLiterals(extractFunction(src, fn));
        if (!body) continue;
        // 形参与本地声明
        const local = new Set<string>();
        for (const dm of body.matchAll(/\b(?:const|let|var)\s+([\w$]+)/g)) local.add(dm[1]);
        for (const p of paramNames(extractSignature(src, fn))) local.add(p);
        for (const cm of body.matchAll(/catch\s*\(\s*([\w$]+)/g)) local.add(cm[1]);
        for (const dm of body.matchAll(/\b(?:const|let|var)\s*\{([^}]*)\}/g)) {
          for (const part of dm[1].split(',')) {
            const name = part.split(':').pop()?.trim().replace(/^\.\.\./, '');
            if (name) local.add(name);
          }
        }
        // 赋值给外层作用域（player = ...）也算本地
        for (const am of body.matchAll(/^\s*([\w$]+)\s*=[^=]/gm)) local.add(am[1]);

        for (const name of KNOWN_GOTCHAS) {
          const used = new RegExp(`(?<![.\\w$'"\`])${name}\\b`).test(body);
          if (used && !local.has(name)) {
            problems.push(`${file}: 函数 ${fn} 引用了未声明的 ${name}`);
          }
        }
      }
    }
    expect(problems).toEqual([]);
  });
});
