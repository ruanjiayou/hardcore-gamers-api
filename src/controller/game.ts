/**
 * 游戏相关的路由
 */

import { Router } from 'express';
import { gameService } from '../services/GameService';
import { pick } from 'lodash';

const router = Router();

// 获取所有游戏
router.get('/', async (req, res) => {
  const games = await gameService.getAllGames(true)
  res.json({ code: 0, data: { list: games } });
});

// 按类型获取游戏
router.get('/genre/:genre', async (req, res) => {
  const games = await gameService.getGamesByGenre(req.params.genre);
  res.json({ code: 0, data: { list: games } });
});

// 获取单个游戏
router.get('/:gameId', async (req, res) => {
  const game = await gameService.getGameById(req.params.gameId);
  if (game) {
    res.json({ code: 0, data: game })
  } else {
    res.status(404).end();
  }
});

// 创建游戏
router.post('/', async (req, res) => {
  await gameService.createGame(req.body);
  res.json({ code: 0 })
});

// 更新游戏
router.put('/:gameId', async (req, res) => {
  await gameService.updateGameStats(req.params.gameId, req.body)
  res.json({ code: 0 })
});

export default router;