import xiangqi from "./xiangqi/index";
import gomoku from "./gomoku";
import othello from "./othello";
import internationalChess from "./international-chess";
import game2048 from "./2048";
import tetris from "./tetris";
import snake from "./snake";

const games: { [key: string]: any } = {
  xiangqi,
  gomoku,
  othello,
  'international-chess': internationalChess,
  '2048': game2048,
  tetris,
  snake,
}

export default games
