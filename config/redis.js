// Redis 연결 설정
require('dotenv').config();

module.exports = {
  host: process.env.REDIS_HOST || 'localhost',
  port: parseInt(process.env.REDIS_PORT || '6379'),
  password: process.env.REDIS_PASSWORD || '',
  db: parseInt(process.env.REDIS_DB || '0'),
  maxRetriesPerRequest: null,
  enableReadyCheck: false,
  // 기본 연결 옵션
  options: {
    maxRetriesPerRequest: null,
    enableReadyCheck: false,
  }
}; 