import xiangqi from "./xiangqi/index";
import gomoku from "./gomoku";
import gomokuRobot from "./gomoku/robot";

export const robots = {
  gomoku: gomokuRobot,
}


const games: { [key: string]: any } = {
  xiangqi,
  gomoku,
}

export default games