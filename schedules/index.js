// 주문 동기화 스케줄러
const cron = require('node-cron');
const { orderSyncQueue } = require('../queues/orderQueue');
const shopRepository = require('../db/shopRepository');
const logger = require('../utils/logger');
const shopeeConfig = require('../config/shopee');

// 스케줄러 초기화
function initSchedulers() {
  logger.info('주문 동기화 스케줄러 초기화 중...');

  // 주문 상태별 동기화 작업 정의
  const scheduleOrderSync = async (status) => {
    try {
      logger.info(`${status} 상태 주문 동기화 작업 시작`);
      
      // 모든 활성 상점 조회
      const shops = await shopRepository.getAllActiveShops();
      
      if (!shops || shops.length === 0) {
        logger.warn('활성화된 상점이 없음');
        return;
      }
      
      logger.info(`활성 상점 ${shops.length}개에 대해 주문 동기화 작업 예약`);
      
      // 각 상점에 대해 주문 동기화 작업 추가
      for (const shop of shops) {
        await orderSyncQueue.add({
          shopId: shop.id,
          status,
          timeFrom: Math.floor((Date.now() - 24 * 60 * 60 * 1000) / 1000), // 24시간 전
          timeTo: Math.floor(Date.now() / 1000) // 현재
        }, {
          attempts: shopeeConfig.retry.attempts,
          backoff: shopeeConfig.retry.backoff
        });
      }
      
      logger.info(`${status} 상태 주문 동기화 작업 예약 완료`);
    } catch (error) {
      logger.error(`주문 동기화 스케줄 작업 오류: ${error.message}`, { error });
    }
  };

  // 주문 상태별 스케줄 설정
  // READY_TO_SHIP 상태: 매 15분마다 실행
  cron.schedule(`*/${shopeeConfig.syncIntervalMinutes} * * * *`, () => {
    scheduleOrderSync(shopeeConfig.orderStatus.READY_TO_SHIP);
  });

  // SHIPPED 상태: 매 시간마다 실행
  cron.schedule('0 * * * *', () => {
    scheduleOrderSync(shopeeConfig.orderStatus.SHIPPED);
  });

  // COMPLETED 상태: 매일 새벽 3시에 실행
  cron.schedule('0 3 * * *', () => {
    scheduleOrderSync(shopeeConfig.orderStatus.COMPLETED);
  });

  // UNPAID 상태: 2시간마다 실행
  cron.schedule('0 */2 * * *', () => {
    scheduleOrderSync(shopeeConfig.orderStatus.UNPAID);
  });

  // CANCELLED 상태: 매일 새벽 4시에 실행
  cron.schedule('0 4 * * *', () => {
    scheduleOrderSync(shopeeConfig.orderStatus.CANCELLED);
  });

  logger.info('주문 동기화 스케줄러 초기화 완료');
}

module.exports = { initSchedulers }; 