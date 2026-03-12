import GomokuAI from '../src/games/gomoku/robot'

const ROLE_BLACK = 1;
const ROLE_WHITE = 2;
// 二维数组，0空，1黑，2白
function getNewBoard(map: Map<string, number>) {
  const board = Array(15).fill([]).map(() => Array(15).fill(0));
  map.forEach((v, k) => {
    const [x, y] = k.split('|').map(n => parseInt(n, 10));
    board[x + 7][y + 7] = v;
  })
  return board;
}
console.log(new GomokuAI(15, 15).getBestMove(getNewBoard(new Map([['0|0', 1]])), ROLE_BLACK));
