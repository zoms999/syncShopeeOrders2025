const cron = require('node-cron');
const logger = require('../utils/logger');
const shopRepository = require('../db/shopRepository');
const orderService = require('../services/orderService');
const config = require('../config/config');

class OrderScheduler {
  constructor() {
    this.cronExpression = config.scheduler.cronExpression;
    this.isRunning = false;
    this.currentJobs = new Map(); // 실행 중인 작업 목록
  }

  /**
   * 스케줄러 시작
   */
  start() {
    logger.info(`주문 수집 스케줄러 시작 (cron: ${this.cronExpression})`);
    
    // 주문 수집 작업 스케줄링
    cron.schedule(this.cronExpression, async () => {
      // 이미 작업이 실행 중인 경우 건너뜀
      if (this.isRunning) {
        logger.warn('이전 주문 수집 작업이 아직 실행 중입니다. 이번 실행은 건너뜁니다.');
        return;
      }
      
      this.isRunning = true;
      
      try {
        // 활성화된 쇼피 샵 목록 조회
        const shops = await shopRepository.getActiveShops();
        
        if (!shops || shops.length === 0) {
          logger.info('활성화된 쇼피 샵이 없습니다.');
          this.isRunning = false;
          return;
        }
        
        logger.info(`활성화된 쇼피 샵 ${shops.length}개에 대한 주문 수집 시작`);
        
        // 각 샵에 대한 주문 수집 작업 실행
        await this._collectOrdersForShops(shops);
        
        logger.info('모든 샵의 주문 수집 작업 완료');
      } catch (error) {
        logger.error('주문 수집 작업 중 오류 발생:', error);
      } finally {
        this.isRunning = false;
      }
    });
    
    // 초기 실행 (즉시 1회 실행)
    this._initialRun();
  }
  
  /**
   * 초기 실행 (서비스 시작 시 1회 실행)
   * @private
   */
  async _initialRun() {
    try {
      logger.info('초기 주문 수집 작업 시작');
      
      // 활성화된 쇼피 샵 목록 조회
      const shops = await shopRepository.getActiveShops();
      
      if (!shops || shops.length === 0) {
        logger.info('활성화된 쇼피 샵이 없습니다.');
        return;
      }
      
      // 각 샵에 대한 주문 수집 작업 실행
      await this._collectOrdersForShops(shops);
      
      logger.info('초기 주문 수집 작업 완료');
    } catch (error) {
      logger.error('초기 주문 수집 작업 중 오류 발생:', error);
    }
  }
  
  /**
   * 각 샵에 대한 주문 수집 작업 실행
   * @private
   * @param {Array} shops - 샵 목록
   */
  async _collectOrdersForShops(shops) {
    // 병렬 처리를 위한 Promise 배열
    const collectPromises = shops.map(async (shop) => {
      const shopId = shop.shop_id;
      
      // 해당 샵에 대한 작업이 이미 실행 중인 경우 건너뜀
      if (this.currentJobs.has(shopId)) {
        logger.warn(`샵 ID ${shopId}에 대한 작업이 이미 실행 중입니다. 건너뜁니다.`);
        return;
      }
      
      // 작업 시작
      this.currentJobs.set(shopId, true);
      
      try {
        logger.info(`샵 ID ${shopId} 주문 수집 시작`);
        
        // 주문 수집 실행
        const result = await orderService.collectOrders(shop);
        
        if (result.success) {
          logger.info(`샵 ID ${shopId} 주문 수집 완료 (성공: ${result.stats.success}, 실패: ${result.stats.failed}, 총계: ${result.stats.total})`);
        } else {
          logger.error(`샵 ID ${shopId} 주문 수집 실패: ${result.error}`);
        }
        
        return result;
      } catch (error) {
        logger.error(`샵 ID ${shopId} 주문 수집 중 오류 발생:`, error);
      } finally {
        // 작업 완료 표시
        this.currentJobs.delete(shopId);
      }
    });
    
    // 모든 작업 완료 대기
    await Promise.all(collectPromises);
  }
  
  /**
   * 특정 샵에 대한 주문 수집 즉시 실행
   * @param {string} shopId - 샵 ID
   * @returns {Promise<Object>} - 수집 결과
   */
  async runForShop(shopId) {
    try {
      // 해당 샵 정보 조회
      const shops = await shopRepository.getActiveShops();
      const shop = shops.find(s => s.shop_id === shopId);
      
      if (!shop) {
        logger.error(`샵 ID ${shopId}을 찾을 수 없습니다.`);
        return { success: false, error: '샵을 찾을 수 없음' };
      }
      
      // 해당 샵에 대한 작업이 이미 실행 중인 경우
      if (this.currentJobs.has(shopId)) {
        logger.warn(`샵 ID ${shopId}에 대한 작업이 이미 실행 중입니다.`);
        return { success: false, error: '이미 실행 중' };
      }
      
      // 작업 시작
      this.currentJobs.set(shopId, true);
      
      try {
        logger.info(`샵 ID ${shopId} 주문 수집 수동 실행`);
        
        // 주문 수집 실행
        const result = await orderService.collectOrders(shop);
        
        if (result.success) {
          logger.info(`샵 ID ${shopId} 주문 수집 완료 (성공: ${result.stats.success}, 실패: ${result.stats.failed}, 총계: ${result.stats.total})`);
        } else {
          logger.error(`샵 ID ${shopId} 주문 수집 실패: ${result.error}`);
        }
        
        return result;
      } finally {
        // 작업 완료 표시
        this.currentJobs.delete(shopId);
      }
    } catch (error) {
      logger.error(`샵 ID ${shopId} 주문 수집 수동 실행 중 오류 발생:`, error);
      return { success: false, error: error.message };
    }
  }
}

module.exports = new OrderScheduler(); 