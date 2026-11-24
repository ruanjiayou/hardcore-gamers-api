/**
 * 贪吃蛇「团队模式」的队伍配置（纯数据，无 IO）。
 *
 * 团队模式：最多 6 支队伍，每队最多 5 人（合计 30 人同场）。
 * - 队伍归属由房间的 seats 决定（每支队伍一个座位块 + 容量），
 *   玩家进房时按"当前人数最少的队伍"自动均衡分队；
 * - 队友之间不会互相碰撞致死（同队豁免），因此 5 人一队可以互相掩护；
 * - 一支队伍全员出局即视为该队淘汰；只剩一支队伍时该队获胜。
 *
 * 队伍配置在三处出现，种子数据与官方房都从这里生成，避免各处硬编码导致不一致：
 * - 房间座位 rooms.seats：[{ team, size }]（schema 字段名是 team）
 * - 游戏变体 game.variants[].teams：[{ name, size }]（schema 字段名是 name）
 * - 游戏角色表 game.role_config.roles：[{ name, size }]
 */

/** 每队人数上限 */
export const SNAKE_TEAM_SIZE = 5;

/** 队伍数量上限 */
export const SNAKE_TEAM_COUNT = 6;

/** 队伍名（同时是队伍标识，房间 seats 与对局数据都用它） */
export const SNAKE_TEAM_NAMES = ['红队', '蓝队', '黄队', '绿队', '紫队', '橙队'];

/** 房间座位：[{ team, size }]，rooms.seats 用这个形态 */
export function snakeTeamSeats(): { team: string; size: number }[] {
  return SNAKE_TEAM_NAMES.map(team => ({ team, size: SNAKE_TEAM_SIZE }));
}

/** 角色表 / 变体队伍：[{ name, size }]，role_config.roles 与 variants[].teams 用这个形态 */
export function snakeTeamRoles(): { name: string; size: number }[] {
  return SNAKE_TEAM_NAMES.map(name => ({ name, size: SNAKE_TEAM_SIZE }));
}

/** 团队模式房间人数上限：6 队 × 5 人 */
export const SNAKE_TEAM_TOTAL = SNAKE_TEAM_COUNT * SNAKE_TEAM_SIZE;
