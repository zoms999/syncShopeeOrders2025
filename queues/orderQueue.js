// 주문 처리 큐 설정
const Queue = require('bull');
const Redis = require('ioredis');
const logger = require('../utils/logger');
const redisConfig = require('../config/redis');
const shopeeConfig = require('../config/shopee');
const config = require('../config/config');

// Redis 클라이언트 생성
const createRedisClient = () => {
  const client = new Redis({
    host: redisConfig.host,
    port: redisConfig.port,
    password: redisConfig.password,
    db: redisConfig.db,
    maxRetriesPerRequest: redisConfig.maxRetriesPerRequest,
    enableReadyCheck: redisConfig.enableReadyCheck
  });

  client.on('error', (err) => {
    logger.error('Redis 연결 오류', { error: err.message });
  });

  client.on('connect', () => {
    logger.info('Redis 서버에 연결됨', { host: redisConfig.host, port: redisConfig.port });
  });

  return client;
};

// 주문 수집 큐 생성
const orderCollectionQueue = new Queue('orderCollection', {
  redis: {
    host: config.redis.host,
    port: config.redis.port,
    password: config.redis.password
  },
  defaultJobOptions: {
    attempts: 3,
    backoff: {
      type: 'exponential',
      delay: 1000
    },
    removeOnComplete: 100, // 성공한 작업 중 최대 100개만 저장
    removeOnFail: 200      // 실패한 작업 중 최대 200개만 저장
  }
});

// 주문 세부 정보 처리 큐
const orderDetailQueue = new Queue('orderDetail', {
  redis: {
    host: config.redis.host,
    port: config.redis.port,
    password: config.redis.password
  },
  defaultJobOptions: {
    attempts: 3,
    backoff: {
      type: 'exponential',
      delay: 2000
    },
    removeOnComplete: 100,
    removeOnFail: 200
  }
});

// 배송 정보 처리 큐
const shipmentInfoQueue = new Queue('shipmentInfo', {
  redis: {
    host: config.redis.host,
    port: config.redis.port,
    password: config.redis.password
  },
  defaultJobOptions: {
    attempts: 3,
    backoff: {
      type: 'exponential',
      delay: 2000
    },
    removeOnComplete: 100,
    removeOnFail: 200
  }
});

// 재고 업데이트 큐
const inventoryQueue = new Queue('inventory', {
  redis: {
    host: config.redis.host,
    port: config.redis.port,
    password: config.redis.password
  },
  defaultJobOptions: {
    attempts: 3,
    backoff: {
      type: 'exponential',
      delay: 1500
    },
    removeOnComplete: 100,
    removeOnFail: 200
  }
});

// 큐 이벤트 핸들러 설정
const setupQueueErrorHandling = (queue) => {
  queue.on('error', (error) => {
    logger.error(`${queue.name} 큐 오류:`, error);
  });

  queue.on('failed', (job, error) => {
    logger.error(`${queue.name} 작업 실패 (작업 ID: ${job.id}):`, {
      error: error.message,
      jobData: job.data,
      attempts: job.attemptsMade
    });
  });

  queue.on('stalled', (jobId) => {
    logger.warn(`${queue.name} 작업이 스톨 상태가 됨 (작업 ID: ${jobId})`);
  });
};

// 모든 큐에 에러 핸들링 설정
setupQueueErrorHandling(orderCollectionQueue);
setupQueueErrorHandling(orderDetailQueue);
setupQueueErrorHandling(shipmentInfoQueue);
setupQueueErrorHandling(inventoryQueue);

// 프로세스 종료 시 모든 큐 정리
const closeQueues = async () => {
  logger.info('큐 연결 종료 중...');
  await orderCollectionQueue.close();
  await orderDetailQueue.close();
  await shipmentInfoQueue.close();
  await inventoryQueue.close();
  logger.info('모든 큐 연결이 종료되었습니다.');
};

process.on('SIGINT', async () => {
  await closeQueues();
  });

process.on('SIGTERM', async () => {
  await closeQueues();
});

module.exports = {
  orderCollectionQueue,
  orderDetailQueue,
  shipmentInfoQueue,
  inventoryQueue,
  closeQueues
}; 