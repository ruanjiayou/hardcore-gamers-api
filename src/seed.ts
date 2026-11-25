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
import { MAsset, MAssetPack, MGame, MMeta, MPlayer, MRoom, MUser } from './models';
import config from './config';
import redis from './utils/redis';
import { SEED_ASSETS, SEED_ASSET_PACKS, SEED_GAMES, SEED_ROBOTS, robotPlayerSeed, officialRoomSeeds, stripRobotEmoji } from './seed.data';
import { normalizeOwner } from './utils/roomPolicy';
import type { IAsset } from './types';

export { SEED_GAMES, SEED_ROBOTS, SEED_ASSET_PACKS, SEED_ASSETS };

export interface SeedResult {
  inserted: number;
  kept: number;
}

/**
 * 写入种子游戏：**已存在的完全不碰**。
 *
 * 以前这里会「校正」mode / numbers / variants / boards，结果是在后台改了配置、重启又被打回去。
 * 代码只负责首次把游戏灌进去，之后运营配置以库为准。
 */
export async function seedGames(): Promise<SeedResult> {
  let inserted = 0;
  let kept = 0;
  for (const game of SEED_GAMES) {
    const existing = await MGame.findOne({ slug: game.slug }, { _id: 1 }).lean(true);
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
/** 一次性初始化标记：写进去之后重启不再灌资源（管理端删掉的资源不会被复活） */
const ASSETS_SEED_KEY = 'assets_seed_v1';

/**
 * 资源种子：**只在首次部署执行一次**。
 *
 * 为什么要有标记而不是「缺了就补」：资源是运营数据，后台会删图、换 URL、调上下架。
 * 每次启动按种子补齐会让「删掉的又回来、改过的被覆盖」。灌过一次就永久放手，
 * 以后新增资源走管理端（或删掉 `meta` 里这条标记重跑 seed）。
 */
export async function seedAssets(): Promise<SeedResult> {
  const marker = await MMeta.findById(ASSETS_SEED_KEY).lean(true);
  if (marker) return { inserted: 0, kept: 0 };

  for (const pack of SEED_ASSET_PACKS) {
    await MAssetPack.updateOne({ _id: pack._id }, { $setOnInsert: pack }, { upsert: true });
  }
  let inserted = 0;
  for (const asset of SEED_ASSETS) {
    // 按业务键 upsert：库里若已手工建过同 group/key 的行，不会插出重复（唯一索引会拦）
    const res = await MAsset.updateOne(
      { pack: asset.pack, game: asset.game, group: asset.group, key: asset.key },
      { $setOnInsert: asset },
      { upsert: true },
    );
    if (res.upsertedCount) inserted++;
  }
  await MMeta.updateOne(
    { _id: ASSETS_SEED_KEY },
    { $set: { value: { packs: SEED_ASSET_PACKS.length, assets: inserted, at: new Date() }, updatedAt: new Date() } },
    { upsert: true },
  );
  await redis.del(config.prefix + 'asset-packs').catch(() => 0);
  console.log(`🎨 资源初始化（仅首次）：${SEED_ASSET_PACKS.length} 个包 / 新增 ${inserted} 条资源`);
  return { inserted, kept: 0 };
}

/**
 * 一次性结构迁移的标记：资源从「包级共用」改成「按游戏各配一份」。
 * 与 `ASSETS_SEED_KEY` 分开：灌种子和改结构是两件事，各自有各的一次性标记。
 */
const ASSETS_GAME_SCOPE_KEY = 'assets_game_scope_v1';

/**
 * 一次性结构迁移：把「全游戏共用一份 BGM」改成「每个游戏各配一份 BGM」。
 *
 * 只做两件事，不覆盖运营改过的内容：
 * 1. 包级 BGM（`game=''`）按游戏复制成游戏级 BGM 行（URL 沿用原文件，
 *    后台想给某个游戏换曲子，单独改那一行即可）；
 * 2. 历史蛇皮肤行补上 `equippable=true`（玩家级可装备外观的标记）。
 *
 * 音效本来就是游戏级的、图片本来就是游戏级的，都不用动。
 * 跑过一次就写标记，之后永不重跑（避免把运营新配的包级 BGM 又复制一遍）。
 */
export async function migrateAssetsToGameScope(): Promise<{ bgmRows: number; marked: number }> {
  const marker = await MMeta.findById(ASSETS_GAME_SCOPE_KEY).lean(true);
  if (marker) return { bgmRows: 0, marked: 0 };

  const games = await MGame.find({}, { slug: 1 }).lean(true) as any[];
  const slugs = [...new Set(games.map(g => g?.slug).filter(Boolean))] as string[];

  let bgmRows = 0;
  const genericBgm = await MAsset.find({ game: '', group: 'bgm' }).lean(true) as IAsset[];
  for (const row of genericBgm) {
    for (const slug of slugs) {
      const res = await MAsset.updateOne(
        { pack: row.pack, game: slug, group: 'bgm', key: row.key },
        {
          $setOnInsert: {
            ...row,
            _id: `${row.pack}_${slug}_bgm_${row.key}`,
            game: slug,
            equippable: false,
            createdAt: new Date(),
            updatedAt: new Date(),
          },
        },
        { upsert: true },
      );
      if (res.upsertedCount) bgmRows++;
    }
  }
  // 包级 BGM 删掉：留着的话它会盖住游戏级那一行（合并时后写入的赢）
  if (genericBgm.length) await MAsset.deleteMany({ game: '', group: 'bgm' });

  // 历史蛇皮肤 → 玩家级可装备
  const marked = await MAsset.updateMany({ group: 'snake', kind: 'image' }, { $set: { equippable: true } });

  await MMeta.updateOne(
    { _id: ASSETS_GAME_SCOPE_KEY },
    { $set: { value: { bgmRows, marked: marked.modifiedCount, at: new Date() }, updatedAt: new Date() } },
    { upsert: true },
  );
  await redis.del(config.prefix + 'asset-packs').catch(() => 0);
  console.log(`🎨 资源按游戏拆分（一次性迁移）：BGM ${bgmRows} 行 / 标记可装备外观 ${marked.modifiedCount} 行`);
  return { bgmRows, marked: marked.modifiedCount };
}

/** 服务启动时统一初始化 */
export async function seedAll() {
  await seedGames();
  await seedRobots();
  await seedOfficialRooms();
  await seedAssets();
  await migrateAssetsToGameScope();
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
