import GomokuAI from "./gomoku/robot";

const instances: any = {};

export default {
  getRobot(player_id: string, slug: string) {
    if (instances[player_id]) {
      return instances[player_id]
    } else if (slug === 'gomoku') {
      instances[player_id] = new GomokuAI(15, 15);
      return instances[player_id]
    } else {
      return;
    }
  }
}