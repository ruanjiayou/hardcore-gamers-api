/**
 * 贪吃蛇「团队模式」的队伍配置（纯数据，无 IO）。
 *
 * 团队模式：3 支队伍，每队最多 5 人（合计 15 人同场）。
 * - 一个团队房 = 一支队伍（最多 5 人）；3 个队房凑齐后合为 1 局，
 *   队伍归属在合局时按房间顺序分配，进房阶段成员不带 team。
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

/** 队伍数量上限：3 个队房合 1 局 */
export const SNAKE_TEAM_COUNT = 3;

/** 队伍名（同时是队伍标识，合局时按房间顺序分配） */
export const SNAKE_TEAM_NAMES = ['红队', '蓝队', '黄队'];

/** 房间座位：[{ team, size }]，rooms.seats 用这个形态 */
export function snakeTeamSeats(): { team: string; size: number }[] {
  return SNAKE_TEAM_NAMES.map(team => ({ team, size: SNAKE_TEAM_SIZE }));
}

/** 角色表 / 变体队伍：[{ name, size }]，role_config.roles 与 variants[].teams 用这个形态 */
export function snakeTeamRoles(): { name: string; size: number }[] {
  return SNAKE_TEAM_NAMES.map(name => ({ name, size: SNAKE_TEAM_SIZE }));
}

/** 团队模式全场人数上限：3 队 × 5 人（单房上限是 SNAKE_TEAM_SIZE） */
export const SNAKE_TEAM_TOTAL = SNAKE_TEAM_COUNT * SNAKE_TEAM_SIZE;
