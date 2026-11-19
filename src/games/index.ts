import xiangqi from "./xiangqi/index";
import gomoku from "./gomoku";
import othello from "./othello";
import internationalChess from "./international-chess";
import game2048 from "./2048";

const games: { [key: string]: any } = {
  xiangqi,
  gomoku,
  othello,
  'international-chess': internationalChess,
  '2048': game2048,
}

export default games