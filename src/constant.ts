const Events = {
  RoomDetai: '',
  RoomUpdateSetting: '',
  RoomDisband: '',

  SendMessage: '',

  PlayerKick: '',
  PlayerKicked: '',
  PlayerAddRobot: '',
  PlayerLeave: '',
  PlayerLeaved: '',
  PlayerReady: '',
  PlayerAction: '',
  GameStart: '',
  GameOver: '',
  GameSurrender: '',
  GameOfferDraw: '',
  GameGetState: '',
} as const;

export enum GameGenre {
  fps = 'fps',
  rpg = 'rpg',
  moba = 'moba',
  card = 'card',
  puzzle = 'puzzle',
}
export enum RoomStatus {
  waiting = 'waiting',
  readied = 'readied',
  playing = 'playing',
  deleted = 'deleted',
}
export enum PlayerState {
  online = 'online',
  inroom = 'inroom',
  ingame = 'ingame',
  offline = 'offline',
  prepared = 'prepared',
  watching = 'watching',
  matching = 'matching',
}
export enum PlayerType {
  player = 'player',
  robot = 'robot',
}
export enum MemberType {
  player = 'player',
  viewer = 'viewer',
}
export enum MatchStatus {
  waiting = 'waiting',
  playing = 'playing',
  aborted = 'aborted',
  gameover = 'gameover',
}
/** 人机难度档：与 robot/src/engine/snake.ts 的 SNAKE_DIFFICULTIES 一一对应，默认 normal */
export const ROBOT_DIFFICULTIES = ['easy', 'normal', 'hard', 'master'] as const;
export type RobotDifficulty = (typeof ROBOT_DIFFICULTIES)[number];
export const DEFAULT_ROBOT_DIFFICULTY: RobotDifficulty = 'normal';
export const isRobotDifficulty = (v: unknown): v is RobotDifficulty =>
  typeof v === 'string' && (ROBOT_DIFFICULTIES as readonly string[]).includes(v);
const constant = {
  Events,
  GAME: {
    GENRE: GameGenre,
  },
  ROOM: {
    STATUS: RoomStatus
  },
  MATCH: {
    STATUS: MatchStatus,
  },
  USER: {
    STATUS: {
      normal: 1,
      muted: 2,
      banned: 3,
    },
  },
  PLAYER: {
    STATE: PlayerState,
    TYPE: PlayerType,
    DIFFICULTY: ROBOT_DIFFICULTIES,
    DEFAULT_DIFFICULTY: DEFAULT_ROBOT_DIFFICULTY,
  },
  MEMBER: {
    TYPE: MemberType,
  },
};

export default constant