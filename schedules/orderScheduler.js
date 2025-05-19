const cron = require('node-cron');
const logger = require('../utils/logger');
const shopRepository = require('../db/shopRepository');
const config = require('../config/config');
const { orderCollectionQueue } = require('../queues/orderQueue');
const cluster = require('cluster');

class OrderScheduler {
  constructor() {
    this.cronExpression = config.scheduler.cronExpression;
    this.isRunning = false;
    this.currentJobs = new Map(); // 실행 중인 작업 목록
    this.cronJob = null;
  }

  /**
   * 스케줄러 시작
   */
  start() {
    // 워커에서는 스케줄러 시작하지 않음 (마스터만 스케줄링)
    if (cluster.isWorker) {
      logger.debug('워커 프로세스에서는 스케줄러를 시작하지 않습니다.');
      return;
    }
    
    logger.info(`주문 수집 스케줄러 시작 (cron: ${this.cronExpression}, 샌드박스 모드: ${config.shopee.isSandbox})`);
    
    // 주문 수집 작업 스케줄링
    this.cronJob = cron.schedule(this.cronExpression, async () => {
      // 이미 작업이 실행 중인 경우 건너뜀
      if (this.isRunning) {
        logger.warn('이전 주문 수집 작업이 아직 실행 중입니다. 이번 실행은 건너뜁니다.');
        return;
      }
      
      this.isRunning = true;
      
      try {
        // 활성화된 쇼피 샵 목록 조회 (샌드박스 설정 적용)
        const shops = await shopRepository.getActiveShops(config.shopee.isSandbox);
        
        if (!shops || shops.length === 0) {
          logger.info(`활성화된 쇼피 샵이 없습니다 (샌드박스 모드: ${config.shopee.isSandbox}).`);
          this.isRunning = false;
          return;
        }
        
        logger.info(`활성화된 쇼피 샵 ${shops.length}개에 대한 주문 수집 시작 (샌드박스 모드: ${config.shopee.isSandbox})`);
        
        // 분산 처리를 위해 Bull 큐에 작업 추가
        if (config.cluster.enabled) {
          await this._addOrderCollectionJobsToQueue(shops);
        } else {
          // 단일 프로세스 모드인 경우 직접 처리
          await this._collectOrdersForShops(shops);
        }
        
        logger.info('모든 샵의 주문 수집 작업 등록 완료');
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
      logger.info(`초기 주문 수집 작업 시작 (샌드박스 모드: ${config.shopee.isSandbox})`);
      
      // 활성화된 쇼피 샵 목록 조회 (샌드박스 설정 적용)
      const shops = await shopRepository.getActiveShops(config.shopee.isSandbox);
      
      if (!shops || shops.length === 0) {
        logger.info(`활성화된 쇼피 샵이 없습니다 (샌드박스 모드: ${config.shopee.isSandbox}).`);
        return;
      }
      
      // 분산 처리를 위해 Bull 큐에 작업 추가
      if (config.cluster.enabled) {
        logger.info(`클러스터 모드로 ${shops.length}개 샵의 주문 수집 작업 등록`);
        await this._addOrderCollectionJobsToQueue(shops);
      } else {
        // 각 샵에 대한 주문 수집 작업 실행
        logger.info(`단일 프로세스 모드로 ${shops.length}개 샵의 주문 수집 작업 실행`);
        await this._collectOrdersForShops(shops);
      }
      
      logger.info('초기 주문 수집 작업 등록 완료');
    } catch (error) {
      logger.error('초기 주문 수집 작업 중 오류 발생:', error);
    }
  }
  
  /**
   * 주문 수집 작업을 큐에 추가
   * @private
   * @param {Array} shops - 샵 목록
   */
  async _addOrderCollectionJobsToQueue(shops) {
    // 배치 처리를 위한 Promise 배열
    const addJobPromises = shops.map(async (shop) => {
      try {
        logger.info(`샵 ID ${shop.shop_id} 주문 수집 작업 큐 등록`);
        
        // 주문 수집 작업 큐에 추가
        const job = await orderCollectionQueue.add(
          'collect-shop-orders',
          { shopId: shop.shop_id },
          { 
            attempts: config.scheduler.maxRetryCount,
            backoff: { type: 'exponential', delay: 5000 },
            removeOnComplete: true
          }
        );
        
        logger.debug(`샵 ID ${shop.shop_id} 주문 수집 작업 큐 등록됨 (작업 ID: ${job.id})`);
        
        return { shopId: shop.shop_id, jobId: job.id };
      } catch (error) {
        logger.error(`샵 ID ${shop.shop_id} 주문 수집 작업 큐 등록 실패:`, error);
        return { shopId: shop.shop_id, error: error.message };
      }
    });
    
    // 모든 작업 등록 완료 대기
    await Promise.all(addJobPromises);
    logger.info('모든 샵의 주문 수집 작업이 큐에 추가되었습니다.');
  }
  
  /**
   * 각 샵에 대한 주문 수집 작업 실행 (단일 프로세스 모드용)
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
        
        // 주문 수집 작업 큐에 추가
        const job = await orderCollectionQueue.add(
          'collect-shop-orders',
          { shopId },
          { 
            attempts: config.scheduler.maxRetryCount,
            backoff: { type: 'exponential', delay: 5000 },
            removeOnComplete: true 
          }
        );
        
        logger.info(`샵 ID ${shopId} 주문 수집 작업 큐에 추가됨 (작업 ID: ${job.id})`);
        
        return { shopId, jobId: job.id };
      } catch (error) {
        logger.error(`샵 ID ${shopId} 주문 수집 중 오류 발생:`, error);
        return { shopId, error: error.message };
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
      // 해당 샵 정보 조회 (샌드박스 설정 적용)
      const shops = await shopRepository.getActiveShops(config.shopee.isSandbox);
      const shop = shops.find(s => s.shop_id === shopId);
      
      if (!shop) {
        logger.error(`샵 ID ${shopId}을 찾을 수 없습니다 (샌드박스 모드: ${config.shopee.isSandbox}).`);
        return { success: false, error: '샵을 찾을 수 없음' };
      }
      
      // 해당 샵에 대한 작업이 이미 실행 중인 경우
      if (this.currentJobs.has(shopId)) {
        logger.warn(`샵 ID ${shopId}에 대한 작업이 이미 실행 중입니다.`);
        return { success: false, error: '이미 실행 중' };
      }
      
      logger.info(`샵 ID ${shopId} 주문 수집 수동 실행`);
      
      // 주문 수집 작업 큐에 추가 (높은 우선순위)
      const job = await orderCollectionQueue.add(
        'manual-order-collect',
        { shopId, manual: true },
        { 
          priority: 1, // 높은 우선순위
          attempts: config.scheduler.maxRetryCount,
          backoff: { type: 'exponential', delay: 2000 },
          removeOnComplete: true
        }
      );
      
      logger.info(`샵 ID ${shopId} 주문 수집 작업이 큐에 추가됨 (작업 ID: ${job.id})`);
      
      return { 
        success: true, 
        message: '주문 수집 작업이 큐에 추가되었습니다.',
        jobId: job.id
      };
    } catch (error) {
      logger.error(`샵 ID ${shopId} 주문 수집 수동 실행 중 오류 발생:`, error);
      return { success: false, error: error.message };
    }
  }
  
  /**
   * 스케줄러 종료
   */
  stop() {
    if (this.cronJob) {
      this.cronJob.stop();
      logger.info('주문 수집 스케줄러 종료됨');
    }
  }
}

module.exports = new OrderScheduler(); 