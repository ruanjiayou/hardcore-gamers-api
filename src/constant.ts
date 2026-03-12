
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
export enum MatchStatus {
  waiting = 'waiting',
  playing = 'playing',
  aborted = 'aborted',
  gameover = 'gameover',
}
const constant = {
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
  },
};

export default constant