const constant = {
  GAME: {
    GENRE: {
      fps: 'fps',
      moba: 'moba',
      rpg: 'rpg',
      card: 'card',
      puzzle: 'puzzle',
    }
  },
  ROOM: {
    STATUS: {
      waiting: 'waiting',
      ready: 'ready',
      loading: 'loading',
      playing: 'playing',
      deleted: 'deleted',
    }
  },
  MATCH: {
    STATUS: {
      playing: 'playing',
      finished: 'finished',
    }
  },
  USER: {
    STATUS: {
      normal: 1,
      muted: 2,
      banned: 3,
    },
  },
  PLAYER: {
    STATE: {
      idle: 'idle',
      ready: 'ready',
      playing: 'playing',
      matching: 'matching',
    }
  },
  MEMBER: {
    TYPE: {
      player: 'player',
      viewer: 'viewer'
    }
  }
}

export default constant