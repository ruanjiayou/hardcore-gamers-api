export default {
  mongo_url: 'mongodb://root:fengshows@10.0.15.240:27017/test_v1?authSource=admin&readPreference=primaryPreferred',
  redis_url: '10.0.15.240:6379',
  robot_url: 'http://localhost:8086',
  server_ws_url: 'ws://localhost:3000/',
  prefix: 'game:v1:',
  expires: 60 * 60 * 6,
  secret: 'test',
  // 单个房间允许的机器人上限（固定房模式：人数有限，机器人不能无限加）
  max_robot_per_room: 1,
}