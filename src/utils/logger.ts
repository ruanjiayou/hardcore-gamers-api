/**
 * 日志（`server/src/utils/logger.ts`）—— 薄封装，主体是 pino
 *
 * 格式化、级别、结构化 JSON、子 logger、脱敏、循环引用 / Error 序列化全部交给 `pino`；
 * 这里只补三件 pino 不管的事：
 * 1. 双出口：控制台（TTY 下用 pino-pretty 单行美化）+ 内存环形缓冲（`/api/debug/logs` 的数据源）
 * 2. 接管全局 `console`：110+ 处存量 `console.log` 不用逐个改就有级别与结构
 * 3. `maskDsn()`：pino 的 redact 只能打码对象字段，打不掉 DSN 字符串内部的密码
 *
 * 环境变量：`LOG_LEVEL` / `LOG_PRETTY` / `LOG_RING` / `LOG_BRIDGE` / `NO_COLOR`（均为 pino 原生语义）
 */
import pino from 'pino';
import pretty from 'pino-pretty';
import { Writable } from 'node:stream';
import { inspect } from 'node:util';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const RING_MAX = Math.max(20, Number(process.env.LOG_RING) || 300);
const ring: pino.LogEvent[] = [];

/** 内存出口：只为没有 SSH 时能 `GET /api/debug/logs`，不落盘（落盘交给 docker/tee） */
const memory = new Writable({
  write(chunk, _enc, cb) {
    try {
      ring.push(JSON.parse(chunk.toString()));
      if (ring.length > RING_MAX) ring.shift();
    } catch {
      // 单行解析失败不影响主流程
    }
    cb();
  },
});

const wantPretty =
  process.env.LOG_PRETTY === '1' ||
  (process.env.LOG_PRETTY !== '0' && Boolean(process.stdout.isTTY));

// ponytail: singleLine —— 一条请求一行，否则 pretty 会散成十几行，grep 直接废
const consoleStream = wantPretty
  ? pretty({ translateTime: 'SYS:HH:mm:ss.l', ignore: 'pid,hostname', singleLine: true, colorize: !process.env.NO_COLOR })
  : process.stdout;

export const logger = pino(
  {
    level: process.env.LOG_LEVEL || 'info',
    base: { pid: process.pid },
    // pino 在序列化后按路径 redact，自定义 serializer 里的嵌套字段同样生效
    redact: {
      paths: [
        'req.headers.authorization',
        'req.headers.cookie',
        'req.headers["x-log-token"]',
        'req.body.pass',
        'req.body.password',
        'req.body.pwd',
        'req.body.token',
        'req.body.secret',
        'password',
        'pass',
        'token',
        'secret',
      ],
      censor: '***',
    },
  },
  pino.multistream([
    { level: 'debug', stream: consoleStream },
    { level: 'debug', stream: memory },
  ]),
);

/** `createLogger('room')` → 带 scope 的子 logger（pino child） */
export const createLogger = (scope: string) => logger.child({ scope });

const LEVEL_NAME: Record<number, LogLevel> = { 10: 'debug', 20: 'debug', 30: 'info', 40: 'warn', 50: 'error', 60: 'error' };
const LEVEL_NUM: Record<LogLevel, number> = { debug: 20, info: 30, warn: 40, error: 50 };

/** 最近 N 条日志（`/api/debug/logs` 用）：保留 pino 原始字段（req/res/hint…），只把级别换成名字 */
export function recentLogs(limit = 100, minLevel?: LogLevel) {
  const min = minLevel ? LEVEL_NUM[minLevel] : 0;
  return ring
    .filter(e => e.level >= min)
    .slice(-Math.max(1, Math.min(limit, RING_MAX)))
    .map(e => ({ ...e, ts: e.time, level: LEVEL_NAME[e.level] || 'info' }));
}

/** 进程退出前冲刷（stdout 直写是空操作，换成 destination 后才会真正 flush） */
export function flushLogs(): void {
  try {
    logger.flush?.();
  } catch {
    // 部分 destination 不支持 flush
  }
}

/** `mongodb://user:pass@host` → `mongodb://user:***@host`（redact 打不到字符串内部） */
export function maskDsn(dsn: string): string {
  return dsn ? dsn.replace(/(\/\/[^:/@]*:)([^@]+)(@)/, '$1***$3') : '';
}

/**
 * 接管全局 console：log/info → info，warn → warn，error → error，debug/trace → debug。
 * 唯一目的：110+ 处存量日志不用逐个改。新代码请用 `createLogger()`。
 */
if (process.env.LOG_BRIDGE !== '0') {
  const toMsg = (args: unknown[]) =>
    args.map(a => (typeof a === 'string' ? a : inspect(a, { depth: 4, breakLength: 120 }))).join(' ');
  const c = console as unknown as Record<string, (...args: unknown[]) => void>;
  c.log = (...a) => logger.info(toMsg(a));
  c.info = (...a) => logger.info(toMsg(a));
  c.warn = (...a) => logger.warn(toMsg(a));
  c.error = (...a) => logger.error(toMsg(a));
  c.debug = (...a) => logger.debug(toMsg(a));
  c.trace = (...a) => logger.debug(toMsg(a));
}

export default logger;
