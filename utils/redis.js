const Redis = require('ioredis');
const logger = require('./logger');
const config = require('../config/config');

// Redis 클라이언트 생성
const redisClient = new Redis({
  host: config.redis.host,
  port: config.redis.port,
  password: config.redis.password,
  keyPrefix: 'shopee:',
  retryStrategy: (times) => {
    const delay = Math.min(times * 50, 2000);
    logger.info(`Redis 연결 재시도 중... (${times}번째 시도, ${delay}ms 후)`);
    return delay;
  }
});

// 연결 이벤트 핸들러
redisClient.on('connect', () => {
  logger.info('Redis 서버에 연결됨');
});

redisClient.on('error', (err) => {
  logger.error('Redis 연결 오류:', err);
});

redisClient.on('ready', () => {
  logger.info('Redis 클라이언트 준비 완료');
});

redisClient.on('close', () => {
  logger.warn('Redis 연결 종료됨');
});

// 정상 종료 시 연결 해제
process.on('SIGINT', () => {
  redisClient.quit().then(() => {
    logger.info('Redis 연결 정상 종료');
  });
});

module.exports = redisClient; 