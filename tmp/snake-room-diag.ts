/**
 * 只读诊断：查看远程库里的贪吃蛇房间/对局状态。
 *
 * 用法（必须在 server 目录下跑，脚本引的是 ../src 的模型）：
 *   bun run tmp/snake-room-diag.ts
 *
 * 只读，不写库。排查「房间里的人不见了 / 对局不开 / 蛇不见了」时先跑它。
 */
import mongoose from 'mongoose';
import { MGame, MMatch, MPlayer, MRoom } from '../src/models';

const URL = 'mongodb://root:123456@100.125.39.89:27017/games?authSource=admin';

async function main() {
  await mongoose.connect(URL);

  const game = await MGame.findOne({ slug: 'snake' }).lean(true) as any;
  const out: string[] = [];
  out.push(`贪吃蛇变体: ${JSON.stringify((game?.variants || []).map((v: any) => ({ key: v.key, arena: v.arena ?? null })))}`);

  const rooms = await MRoom.find({ game_id: 'snake' }).sort({ createdAt: 1 }).lean(true) as any[];
  out.push(`贪吃蛇房间共 ${rooms.length} 间：`);
  for (const r of rooms) {
    const members = (r.members || []).map((m: any) => `${m._id}(${m.player_type === 'robot' ? '机' : m.member_type})`);
    out.push(`  ${r._id}  official=${!!r.official}  status=${r.status}  variant=${r.settings?.variant || '-'}  arena=${r.settings?.arena ?? '-'}  numbers=${JSON.stringify(r.numbers)}`);
    out.push(`      members(${members.length}): ${members.join(', ') || '空'}  match_id=${r.match_id || '-'}`);

    if (r.match_id) {
      const match = await MMatch.findById(r.match_id).lean(true) as any;
      if (!match) {
        out.push('      ⚠️ match_id 指向的对局不存在（幽灵对局）');
      } else {
        const players = match.curr_state?.players || [];
        out.push(`      对局 status=${match.status}  变体=${match.curr_state?.variant || '-'}  场上蛇=${players.length}  存活=${players.filter((p: any) => p.alive).length}`);
      }
    }
  }

  // 挂着房间指针但人不在成员表里的玩家（悬空指针）
  const players = await MPlayer.find({ game_id: 'snake', room_id: { $ne: '' } }).lean(true) as any[];
  const roomIds = new Set(rooms.map(r => String(r._id)));
  const dangling = players.filter(p => !roomIds.has(String(p.room_id)));
  if (dangling.length) {
    out.push(`\n⚠️ room_id 悬空的玩家 ${dangling.length} 个：`);
    dangling.forEach(p => out.push(`  ${p._id} ${p.nickname || ''} → room_id=${p.room_id}`));
  }

  await mongoose.disconnect();
  console.log('RESULT>>' + out.join('\nRESULT>>'));
  process.exit(0);
}

main().catch(async (e) => {
  console.error('诊断失败:', e);
  await mongoose.disconnect();
  process.exit(1);
});
