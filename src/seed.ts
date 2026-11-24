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
import { MGame, MPlayer, MRoom, MUser, MVoicePack } from './models';
import config from './config';
import redis from './utils/redis';
import { SEED_GAMES, SEED_ROBOTS, SEED_VOICE_PACKS, robotPlayerSeed, officialRoomSeeds, stripRobotEmoji } from './seed.data';
import { normalizeOwner } from './utils/roomPolicy';

export { SEED_GAMES, SEED_ROBOTS, SEED_VOICE_PACKS };

export interface SeedResult {
  inserted: number;
  kept: number;
}

/**
 * 幂等写入种子游戏：已存在相同 slug 则保留用户数据，但同步 mode 等代码权威的结构性字段。
 * （旧库记录早于 mode 字段写入，跳过会导致 2048 被当成房间模式、单人快开被拒。）
 */
export async function seedGames(): Promise<SeedResult> {
  let inserted = 0;
  let kept = 0;
  for (const game of SEED_GAMES) {
    const existing = await MGame.findOne({ slug: game.slug }).lean(true);
    if (existing) {
      // 结构性字段以种子为准回填/校正，其余字段不覆盖运营数据
      const patch: Record<string, unknown> = {};
      if (existing.mode !== game.mode) patch.mode = game.mode;
      if (existing.numbers?.min !== game.numbers.min || existing.numbers?.max !== game.numbers.max) {
        patch.numbers = game.numbers;
      }
      // 玩法变体 / 分榜也是代码权威的结构性配置（贪吃蛇：无尽 + 多人、两张榜）
      const variantsChanged = JSON.stringify(existing.variants || []) !== JSON.stringify(game.variants || []);
      if (variantsChanged) patch.variants = game.variants || [];
      const boardsChanged = JSON.stringify(existing.boards || []) !== JSON.stringify(game.boards || []);
      if (boardsChanged) patch.boards = game.boards || [];
      if (Object.keys(patch).length > 0) {
        await MGame.updateOne({ _id: existing._id }, { $set: patch });
        console.log(`🔧 游戏数据校正: ${game.slug} ${JSON.stringify(patch)}`);
      }
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
 * 清洗存量人机昵称左侧的 🤖 前缀（UI-054）。
 *
 * 早期 seed / admin 会把机器人名字写成「🤖 贪吃蛇 1 号」，源头（seed.data / admin）
 * 现在不再拼前缀，但库里已落库的 users.name / users.nickname / players.nickname 还带着。
 * 这里做一次性数据迁移：按正则批量去前缀，幂等，跑第二遍没有匹配就什么都不做。
 */
export async function cleanRobotEmoji(): Promise<SeedResult> {
  let changed = 0;
  const users = await MUser.find({
    $or: [{ name: /^\s*🤖/ }, { nickname: /^\s*🤖/ }],
  }).lean(true);
  for (const u of users as any[]) {
    const patch: Record<string, unknown> = { updatedAt: new Date() };
    if (u.name) patch.name = stripRobotEmoji(u.name);
    if (u.nickname) patch.nickname = stripRobotEmoji(u.nickname);
    await MUser.updateOne({ _id: u._id }, { $set: patch });
    changed++;
  }
  const players = await MPlayer.find({ nickname: /^\s*🤖/ }).lean(true);
  for (const p of players as any[]) {
    await MPlayer.updateOne(
      { _id: p._id },
      { $set: { nickname: stripRobotEmoji(p.nickname), updatedAt: new Date() } },
    );
    changed++;
  }
  if (changed > 0) {
    console.log(`🧹 人机昵称清洗：去掉 🤖 前缀 ${changed} 条`);
  }
  return { inserted: changed, kept: 0 };
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
          { $set: { status: room.status, members: [], owner_id: '', match_id: '', settings: room.settings, updatedAt: new Date() } }
        );
      } else {
        // 结构性字段校正：混合玩法游戏（贪吃蛇）的官方桌必须指向房间玩法变体，
        // 否则老库里的官方桌会缺 settings.variant，客户端按单人玩法渲染。
        const wantVariant = room.settings?.variant;
        if (wantVariant && existing.settings?.variant !== wantVariant) {
          await MRoom.updateOne({ _id: room._id }, { $set: { 'settings.variant': wantVariant } });
        }
        // 人数上限校正：无尽模式从 6 人扩到 10 人、团队模式 6 队×5 人后，
        // 老库里的官方桌仍写着旧的 numbers.max，会导致房间装不满人。
        const wantNumbers = room.numbers;
        const numbersChanged =
          !!wantNumbers &&
          (existing.numbers?.min !== wantNumbers.min || existing.numbers?.max !== wantNumbers.max);
        // 队伍座位校正：团队模式官方桌必须带 6 队×5 人的座位表，
        // 否则开局时无法按队伍分配名额（seats 为空会退化成无队模式）。
        const wantSeats = room.seats || [];
        const seatsChanged =
          wantSeats.length > 0 &&
          JSON.stringify(existing.seats || []) !== JSON.stringify(wantSeats);
        // 房主校正（SB-039）：官方房只有「临时房主」，owner_id 必须是房内的真人对战玩家。
        // 历史脏数据里人机当过房主（种子补人机时第一台机器人在空桌接了房主位），
        // 那种房主管理端永远踢不掉，必须在启动时纠正成第一位真人（没有真人则置空）。
        const wantOwner = normalizeOwner(existing as any);
        const ownerChanged = wantOwner !== null && wantOwner !== existing.owner_id;
        if (numbersChanged || seatsChanged || ownerChanged) {
          const patch: Record<string, unknown> = { updatedAt: new Date() };
          if (numbersChanged) patch.numbers = wantNumbers;
          if (seatsChanged) patch.seats = wantSeats;
          if (ownerChanged) patch.owner_id = wantOwner;
          await MRoom.updateOne({ _id: room._id }, { $set: patch });
          if (ownerChanged) {
            console.log(`🏢 官方房 ${room._id} 临时房主校正：${existing.owner_id || '空'} → ${wantOwner || '空'}`);
          }
        }
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

/**
 * 幂等写入语音包：已存在则只同步文件 URL / 权限要求这类配置字段，
 * 不动运营可能修改的 name/desc/cover。
 */
export async function seedVoicePacks(): Promise<SeedResult> {
  let inserted = 0;
  let kept = 0;
  for (const pack of SEED_VOICE_PACKS) {
    const existing = await MVoicePack.findById(pack._id).lean(true);
    if (existing) {
      const patch: Record<string, unknown> = {};
      if (JSON.stringify(existing.bgm) !== JSON.stringify(pack.bgm)) patch.bgm = pack.bgm;
      if (JSON.stringify(existing.sfx) !== JSON.stringify(pack.sfx)) patch.sfx = pack.sfx;
      if (JSON.stringify(existing.games || {}) !== JSON.stringify(pack.games || {})) patch.games = pack.games;
      if (!!existing.isDefault !== pack.isDefault) patch.isDefault = pack.isDefault;
      if (!!existing.requirePermission !== pack.requirePermission) patch.requirePermission = pack.requirePermission;
      if (existing.status !== pack.status) patch.status = pack.status;
      if (Object.keys(patch).length) {
        await MVoicePack.updateOne({ _id: pack._id }, { $set: patch });
      }
      kept++;
      continue;
    }
    await MVoicePack.updateOne({ _id: pack._id }, { $setOnInsert: pack }, { upsert: true });
    inserted++;
  }
  if (inserted || kept) {
    // 配置变了要让列表缓存尽快回源
    await redis.del(config.prefix + 'voice-packs').catch(() => 0);
    console.log(`🎵 语音包初始化：新增 ${inserted} 个，已存在 ${kept} 个`);
  }
  return { inserted, kept };
}

/** 服务启动时统一初始化 */
export async function seedAll() {
  await seedGames();
  await seedRobots();
  await cleanRobotEmoji();
  await seedOfficialRooms();
  await seedVoicePacks();
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
