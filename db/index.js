// DB 연결 설정
const pgp = require('pg-promise')();
const logger = require('../utils/logger');
require('dotenv').config();

// 데이터베이스 연결 옵션
const dbConfig = {
  host: process.env.DB_HOST || 'localhost',
  port: parseInt(process.env.DB_PORT || '5432'),
  database: process.env.DB_NAME || 'shopee_orders',
  user: process.env.DB_USER || 'postgres',
  password: process.env.DB_PASSWORD || '',
  max: parseInt(process.env.DB_POOL_SIZE || '10'), // 최대 연결 수
  idleTimeoutMillis: 30000, // 유휴 연결 타임아웃
  connectionTimeoutMillis: 2000, // 연결 타임아웃
  ssl: process.env.DB_SSL === 'true' ? { rejectUnauthorized: false } : false
};

// DB 연결 모니터링 설정
const initOptions = {
  // 쿼리 실행 시작
  query(e) {
    if (process.env.NODE_ENV !== 'production') {
      logger.debug('실행 쿼리', { query: e.query });
    }
  },

  // 쿼리 에러 발생
  error(err, e) {
    logger.error('쿼리 에러', { 
      error: err.message, 
      query: e.query, 
      params: e.params 
    });
  },

  // 데이터베이스 연결 로그
  connect(client, dc, useCount) {
    const { host, database } = client.connectionParameters;
    logger.info('데이터베이스 연결 성공', { host, database, useCount });
  },

  // 데이터베이스 연결 해제 로그
  disconnect(client, dc) {
    const { host, database } = client.connectionParameters;
    logger.info('데이터베이스 연결 해제', { host, database });
  }
};

// DB 인스턴스 생성
const db = pgp(initOptions)(dbConfig);

// 연결 테스트
db.connect()
  .then(obj => {
    logger.info('데이터베이스 연결 확인 성공');
    obj.done(); // 연결 해제
  })
  .catch(error => {
    logger.error('데이터베이스 연결 실패', { error: error.message });
  });

module.exports = db; 