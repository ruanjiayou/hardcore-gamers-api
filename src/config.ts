// 第一个 import：logger 加载时会接管全局 console，保证下面的配置日志也可带时间戳。
// config 被几乎所有模块依赖，放在这里等于给所有入口（index / seed / 测试）都装好了日志。
import { createLogger, maskDsn } from './utils/logger';
import { Etcd3 } from 'etcd3';

const log = createLogger('config');

/**
 * 配置单一入口：参考 cms-api 用 etcd3 + 环境 namespace 读取配置。
 *
 * 与 cms-api 的差异（按要求）：
 * - 所有配置放在同一个键里，值就是一整个 JSON 对象：`<环境>/games-api`，本环境为 `test/games-api`。
 * - 不做 cms-api 那种按 type 分支 + lodash.set 的额外解析，直接 JSON.parse 后覆盖默认值。
 * - 默认值全部保留字段（空字符串 / 0 / false），保证所有引用处都有 TypeScript 智能提示。
 */
export interface AppConfig {
  /** HTTP 端口 */
  port: number;
  /** JWT / Ticket 签名密钥 */
  secret: string;
  mongo_url: string;
  redis_url: string;
  /** robot 服务地址 */
  robot_url: string;
  /** 发给 robot 服务的本机 WebSocket 地址 */
  server_ws_url: string;
  /** Redis key 前缀 */
  prefix: string;
  /** 统计缓存过期秒数 */
  expires: number;
  /** 每房最多机器人数 */
  max_robot_per_room: number;
  /** 计时功能总开关 */
  enabled: boolean;
  /** 单局计时总预算（分钟） */
  totalBudgetMin: number;
  /** 每步限额（秒） */
  stepLimitSec: number;
  /** 语音包权限白名单（etcd 可配）：这些 user_id 无需在库里置位也能用非默认语音包 */
  voice_pack_allowlist: string[];
  /** 管理端（/admin）登录密码；为空则管理端拒绝登录 */
  admin_pass: string;
}

/** 默认 JSON：字段齐全、值为空字符串 / 0 / false，仅用于类型提示与兜底 */
const defaultConfig: AppConfig = {
  port: 8087,
  secret: '',
  mongo_url: '',
  redis_url: '',
  robot_url: '',
  server_ws_url: '',
  prefix: '',
  expires: 0,
  max_robot_per_room: 0,
  voice_pack_allowlist: [],
  admin_pass: '',
  enabled: false,
  totalBudgetMin: 0,
  stepLimitSec: 0,
};

const config: AppConfig = { ...defaultConfig };

const env = process.env.NODE_ENV || 'test';
const client = new Etcd3({
  hosts: process.env.etcd_url || 'http://192.168.1.124:2379',
  auth: process.env.etcd_user && process.env.etcd_pass
    ? { username: process.env.etcd_user, password: process.env.etcd_pass }
    : undefined,
}).namespace(`${env}/`);

/** 完整键：namespace(env/) + games-api = test/games-api */
const CONFIG_KEY = 'games-api';

let loaded = false;

async function loadConfig() {
  try {
    const raw = await client.get(CONFIG_KEY).string();
    loaded = true;
    if (!raw) {
      log.warn(`etcd 中未找到 ${env}/${CONFIG_KEY}，使用默认空配置`);
      return;
    }
    Object.assign(config, JSON.parse(raw));
    log.info(`已从 etcd 加载 ${env}/${CONFIG_KEY}`);
    // 打印前脱敏：mongo/redis 的 DSN 里带密码，secret 与 admin_pass 更不能落盘
    log.info({
      ...config,
      secret: config.secret ? '***(已配置)' : '',
      admin_pass: config.admin_pass ? '***(已配置)' : '',
      mongo_url: maskDsn(config.mongo_url),
      redis_url: maskDsn(config.redis_url),
    });
  } catch (err) {
    loaded = true;
    // etcd 不可用时保持默认值，避免整个服务启动失败
    log.error(`读取 etcd ${env}/${CONFIG_KEY} 失败：`, err);
  }
}

// 顶层 await：任何 import config 的模块都会等配置加载完成再执行，
// 避免 redis / mongoose / TicketTool 在模块初始化时拿到空配置。
// 加超时保护：etcd 不通时不能让整个服务永远卡在启动阶段。
await Promise.race([
  loadConfig(),
  new Promise(resolve => setTimeout(() => {
    if (!loaded) log.error(`读取 etcd ${env}/${CONFIG_KEY} 超时（5s），使用默认空配置 —— 检查 etcd_url 与网络`);
    resolve(null);
  }, 5000)),
]);

/** 需要手动重新加载时使用（与 cms-api 的 config.init 对齐） */
Object.defineProperty(config, 'init', {
  value: loadConfig,
  enumerable: false,
  writable: false,
  configurable: false,
});

export default config;
