const pgp = require('pg-promise')({
  // 초기화 옵션
});
const config = require('../config/config');
const logger = require('../utils/logger');

// 데이터베이스 연결 설정
const dbConfig = {
  host: config.db.host,
  port: config.db.port,
  database: config.db.database,
  user: config.db.user,
  password: config.db.password,
  schema: config.db.schema,
  max: 30, // 최대 연결 수
  idleTimeoutMillis: 30000, // 유휴 타임아웃
  connectionTimeoutMillis: 2000, // 연결 타임아웃
};

// 데이터베이스 객체 생성
const db = pgp(dbConfig);

// 연결 테스트
db.connect()
  .then(obj => {
    logger.info('데이터베이스 연결 성공');
    obj.done(); // 연결 해제
  })
  .catch(error => {
    logger.error('데이터베이스 연결 실패:', error);
  });

module.exports = db; 