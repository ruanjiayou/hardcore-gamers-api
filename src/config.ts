export default {
  mongo_url: 'mongodb://root:fengshows@10.0.15.240:27017/test_v1?authSource=admin&readPreference=primaryPreferred',
  redis_url: '10.0.15.240:6379',
  robot_url: 'http://localhost:8086',
  prefix: 'game:v1:',
  expires: 60 * 60 * 6,
  secret: 'test',
}