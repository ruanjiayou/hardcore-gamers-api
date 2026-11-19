/**
 * 种子数据初始化
 *
 * - games 集合为空 → 大厅游戏列表一直 loading
 * - 缺少 type=robot 的玩家 → 添加机器人恒返回 false
 * 这里以幂等方式确保两个基础游戏和两个机器人账号始终存在。
 * - 服务启动时自动调用（见 index.ts）
 * - 也可手动运行：bun run seed（在 server 目录下）
 */

import mongoose from 'mongoose';
import { MGame, MPlayer, MRoom, MUser } from './models';
import config from './config';
import { SEED_GAMES, SEED_ROBOTS, robotPlayerSeed, officialRoomSeeds } from './seed.data';

export { SEED_GAMES, SEED_ROBOTS };

export interface SeedResult {
  inserted: number;
  kept: number;
}

/** 幂等写入种子游戏：已存在相同 slug 则跳过，不覆盖用户已有数据。 */
export async function seedGames(): Promise<SeedResult> {
  let inserted = 0;
  let kept = 0;
  for (const game of SEED_GAMES) {
    const existing = await MGame.findOne({ slug: game.slug }).lean(true);
    if (existing) {
      kept++;
      continue;
    }
    await MGame.updateOne({ _id: game._id }, { $setOnInsert: game }, { upsert: true });
    inserted++;
  }
  if (inserted > 0) {
    console.log(`🌱 游戏数据初始化：新增 ${inserted} 个，已存在 ${kept} 个`);
  }
  return { inserted, kept };
}

/** 幂等写入机器人账号：user + player 都要存在，且 state=online 才能被 addRobot 选中。 */
export async function seedRobots(): Promise<SeedResult> {
  let inserted = 0;
  let kept = 0;
  for (const robot of SEED_ROBOTS) {
    const existing = await MPlayer.findOne({ _id: robot.player_id }).lean(true);
    if (existing) {
      // 已存在则只确保其 user 存在，不覆盖运营中状态
      const user = await MUser.findById(robot.user_id).lean(true);
      if (!user) {
        await MUser.updateOne(
          { _id: robot.user_id },
          { $setOnInsert: { _id: robot.user_id, name: robot.user_name, avatar: '🤖', createdAt: new Date(), updatedAt: new Date() } },
          { upsert: true }
        );
      }
      kept++;
      continue;
    }
    await MUser.updateOne(
      { _id: robot.user_id },
      { $setOnInsert: { _id: robot.user_id, name: robot.user_name, avatar: '🤖', createdAt: new Date(), updatedAt: new Date() } },
      { upsert: true }
    );
    await MPlayer.create(robotPlayerSeed(robot));
    inserted++;
  }
  if (inserted > 0) {
    console.log(`🤖 机器人账号初始化：新增 ${inserted} 个，已存在 ${kept} 个`);
  }
  return { inserted, kept };
}

/**
 * 幂等写入官方公共房：每个房间制游戏 4 个固定桌位。
 * 已存在（含已有玩家使用中）则跳过，不覆盖运营中状态；
 * 但若被误删（status=deleted）则复活为 waiting 空房。
 */
export async function seedOfficialRooms(): Promise<SeedResult> {
  let inserted = 0;
  let kept = 0;
  for (const room of officialRoomSeeds()) {
    const existing = await MRoom.findById(room._id).lean(true);
    if (existing) {
      if ((existing as any).status === 'deleted' && (!existing.members || existing.members.length === 0)) {
        // 空的已解散官方房：复活，保证每游戏始终有 4 桌
        await MRoom.updateOne(
          { _id: room._id },
          { $set: { status: room.status, members: [], owner_id: '', match_id: '', updatedAt: new Date() } }
        );
      }
      kept++;
      continue;
    }
    await MRoom.create(room);
    inserted++;
  }
  if (inserted > 0) {
    console.log(`🏢 官方房间初始化：新增 ${inserted} 间，已存在 ${kept} 间`);
  }
  return { inserted, kept };
}

/** 服务启动时统一初始化 */
export async function seedAll() {
  await seedGames();
  await seedRobots();
  await seedOfficialRooms();
}

// 支持作为脚本单独运行：bun run seed（server 目录下）
if (import.meta.main) {
  try {
    if (mongoose.connection.readyState === 0) {
      await mongoose.connect(config.mongo_url);
    }
    await seedAll();
    console.log('✅ 种子数据初始化完成');
  } catch (error) {
    console.error('❌ 种子数据初始化失败：', error);
    process.exitCode = 1;
  } finally {
    await mongoose.disconnect();
  }
}
