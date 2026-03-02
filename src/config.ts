export default {
  mongo_url: 'mongodb://root:123456@192.168.0.124:27017/test_v1?authSource=admin&readPreference=primaryPreferred',
  redis_url: '192.168.0.124:6379',
  prefix: 'game:v1:',
  expires: 60 * 60 * 6,
  secret: 'test',
}