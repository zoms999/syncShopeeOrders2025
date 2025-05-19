const cluster = require('cluster');
const logger = require('./utils/logger');
const config = require('./config/config');
const orderService = require('./services/orderService');
const shopRepository = require('./db/shopRepository');
const {
  orderCollectionQueue,
  orderDetailQueue,
  shipmentInfoQueue,
  inventoryQueue
} = require('./queues/orderQueue');

/**
 * 워커 프로세스 클래스
 */
class Worker {
  constructor() {
    this.workerId = cluster.worker ? cluster.worker.id : 0;
    this.activeJobs = 0;
    this.status = 'idle';
    this.lastStatusUpdate = Date.now();
  }

  /**
   * 마스터에 상태 보고
   */
  reportStatus() {
    if (cluster.worker) {
      const statusReport = {
        type: 'status',
        workerId: this.workerId,
        status: this.status,
        jobs: this.activeJobs,
        timestamp: Date.now()
      };
      
      cluster.worker.send(statusReport);
      
      // 로그에 상태 기록 (DEBUG 레벨)
      logger.debug(`워커 ${this.workerId} 상태 보고: ${this.status}, 활성 작업: ${this.activeJobs}`);
    }
  }

  /**
   * 주문 수집 작업 프로세서
   */
  async processOrderCollection(job) {
    const { shopId, manual = false } = job.data;
    
    try {
      this.activeJobs++;
      this.status = 'processing-orders';
      this.reportStatus();
      
      logger.info(`워커 ${this.workerId}: 샵 ID ${shopId} 주문 수집 작업 시작 ${manual ? '(수동)' : ''} (샌드박스 모드: ${config.shopee.isSandbox})`);
      
      // 샵 정보 조회
      let shop;
      if (shopId) {
        try {
          // 특정 샵만 처리
          shop = await shopRepository.getShopById(shopId);
          
          // 샵을 찾을 수 없는 경우 활성 샵 목록에서 찾기
          if (!shop) {
            logger.warn(`샵 ID ${shopId}를 getShopById로 찾을 수 없어 활성 샵 목록에서 검색합니다.`);
            const activeShops = await shopRepository.getActiveShops(config.shopee.isSandbox);
            shop = activeShops.find(s => s.shop_id === shopId || s.shop_id.toString() === shopId.toString());
          }
          
          if (!shop) {
            throw new Error(`샵 ID ${shopId}를 찾을 수 없습니다 (샌드박스 모드: ${config.shopee.isSandbox}).`);
          }
        } catch (error) {
          logger.error(`getShopById 메서드 실행 중 오류:`, error);
          
          // getShopById 메서드 실패 시 활성 샵 목록에서 찾기
          logger.info(`활성 샵 목록에서 샵 ID ${shopId}를 검색합니다 (샌드박스 모드: ${config.shopee.isSandbox}).`);
          const activeShops = await shopRepository.getActiveShops(config.shopee.isSandbox);
          shop = activeShops.find(s => s.shop_id === shopId || s.shop_id.toString() === shopId.toString());
          
          if (!shop) {
            throw new Error(`샵 ID ${shopId}를 찾을 수 없습니다 (샌드박스 모드: ${config.shopee.isSandbox}).`);
          }
        }
        
        // 해당 샵의 주문 수집
        const result = await orderService.collectOrders(shop);
        
        if (result.success) {
          logger.info(`워커 ${this.workerId}: 샵 ID ${shopId} 주문 수집 완료 (${result.stats.total}개)`);
          
          // 주문 세부 정보 처리 작업 추가
          if (result.stats.orderSns && result.stats.orderSns.length > 0) {
            // 배치 크기 단위로 분할
            const batchSize = config.scheduler.batchSize;
            for (let i = 0; i < result.stats.orderSns.length; i += batchSize) {
              const batch = result.stats.orderSns.slice(i, i + batchSize);
              
              await orderDetailQueue.add(
                'process-order-details',
                {
                  shopId: shop.shop_id,
                  orderSns: batch
                },
                { priority: manual ? 1 : 3 }
              );
            }
          }
        } else {
          logger.error(`워커 ${this.workerId}: 샵 ID ${shopId} 주문 수집 실패: ${result.error}`);
        }
      } else {
        // 모든 활성 샵 처리
        const shops = await shopRepository.getActiveShops(config.shopee.isSandbox);
        
        logger.info(`워커 ${this.workerId}: 활성화된 샵 ${shops.length}개 주문 수집 시작 (샌드박스 모드: ${config.shopee.isSandbox})`);
        
        // 각 샵에 대해 별도의 작업 추가
        for (const shop of shops) {
          await orderCollectionQueue.add(
            'collect-shop-orders',
            { shopId: shop.shop_id },
            { 
              priority: 5,
              attempts: 2,
              removeOnComplete: true
            }
          );
        }
        
        logger.info(`워커 ${this.workerId}: ${shops.length}개 샵의 주문 수집 작업이 큐에 추가되었습니다 (샌드박스 모드: ${config.shopee.isSandbox}).`);
      }
      
      return { success: true };
    } catch (error) {
      logger.error(`워커 ${this.workerId}: 주문 수집 작업 중 오류:`, error);
      throw error;
    } finally {
      this.activeJobs--;
      this.status = this.activeJobs === 0 ? 'idle' : this.status;
      this.reportStatus();
    }
  }

  /**
   * 주문 세부 정보 처리 작업 프로세서
   */
  async processOrderDetails(job) {
    const { shopId, orderSns } = job.data;
    
    try {
      this.activeJobs++;
      this.status = 'processing-details';
      this.reportStatus();
      
      logger.info(`워커 ${this.workerId}: 샵 ID ${shopId}의 주문 세부 정보 처리 시작 (${orderSns.length}개) (샌드박스 모드: ${config.shopee.isSandbox})`);
      
      // 샵 정보 조회
      let shop;
      try {
        shop = await shopRepository.getShopById(shopId);
        
        // 샵을 찾을 수 없는 경우 활성 샵 목록에서 찾기
        if (!shop) {
          logger.warn(`샵 ID ${shopId}를 getShopById로 찾을 수 없어 활성 샵 목록에서 검색합니다.`);
          const activeShops = await shopRepository.getActiveShops(config.shopee.isSandbox);
          shop = activeShops.find(s => s.shop_id === shopId || s.shop_id.toString() === shopId.toString());
        }
      } catch (error) {
        logger.error(`getShopById 메서드 실행 중 오류:`, error);
        
        // getShopById 메서드 실패 시 활성 샵 목록에서 찾기
        logger.info(`활성 샵 목록에서 샵 ID ${shopId}를 검색합니다 (샌드박스 모드: ${config.shopee.isSandbox}).`);
        const activeShops = await shopRepository.getActiveShops(config.shopee.isSandbox);
        shop = activeShops.find(s => s.shop_id === shopId || s.shop_id.toString() === shopId.toString());
      }
      
      if (!shop) {
        throw new Error(`샵 ID ${shopId}를 찾을 수 없습니다 (샌드박스 모드: ${config.shopee.isSandbox}).`);
      }
      
      // 주문 세부 정보 처리
      const stats = { success: 0, failed: 0, orderSns: [] };
      const result = await orderService._processOrderDetails(shop, orderSns, stats);
      
      logger.info(`워커 ${this.workerId}: 샵 ID ${shopId}의 주문 세부 정보 처리 완료`);
      
      // 배송 정보 처리 작업 추가
      await shipmentInfoQueue.add(
        'process-shipment-info',
        {
          shopId: shop.shop_id,
          orderSns: orderSns
        },
        { priority: 3 }
      );
      
      return { success: true, result };
    } catch (error) {
      logger.error(`워커 ${this.workerId}: 주문 세부 정보 처리 작업 중 오류:`, error);
      throw error;
    } finally {
      this.activeJobs--;
      this.status = this.activeJobs === 0 ? 'idle' : this.status;
      this.reportStatus();
    }
  }

  /**
   * 배송 정보 처리 작업 프로세서
   */
  async processShipmentInfo(job) {
    const { shopId, orderSns } = job.data;
    
    try {
      this.activeJobs++;
      this.status = 'processing-shipment';
      this.reportStatus();
      
      logger.info(`워커 ${this.workerId}: 샵 ID ${shopId}의 배송 정보 처리 시작 (${orderSns.length}개) (샌드박스 모드: ${config.shopee.isSandbox})`);
      
      // 샵 정보 조회
      let shop;
      try {
        shop = await shopRepository.getShopById(shopId);
        
        // 샵을 찾을 수 없는 경우 활성 샵 목록에서 찾기
        if (!shop) {
          logger.warn(`샵 ID ${shopId}를 getShopById로 찾을 수 없어 활성 샵 목록에서 검색합니다.`);
          const activeShops = await shopRepository.getActiveShops(config.shopee.isSandbox);
          shop = activeShops.find(s => s.shop_id === shopId || s.shop_id.toString() === shopId.toString());
        }
      } catch (error) {
        logger.error(`getShopById 메서드 실행 중 오류:`, error);
        
        // getShopById 메서드 실패 시 활성 샵 목록에서 찾기
        logger.info(`활성 샵 목록에서 샵 ID ${shopId}를 검색합니다 (샌드박스 모드: ${config.shopee.isSandbox}).`);
        const activeShops = await shopRepository.getActiveShops(config.shopee.isSandbox);
        shop = activeShops.find(s => s.shop_id === shopId || s.shop_id.toString() === shopId.toString());
      }
      
      if (!shop) {
        throw new Error(`샵 ID ${shopId}를 찾을 수 없습니다 (샌드박스 모드: ${config.shopee.isSandbox}).`);
      }
      
      // 빈 배송 정보 맵 생성
      const shipmentMap = {};
      
      // 배송 정보 가져오기
      await orderService._processTrackingInfoBatch(shop, orderSns, shipmentMap);
      
      // 송장번호 정보 저장
      await orderService._saveTrackingNumbers(shop, Object.values(shipmentMap));
      
      logger.info(`워커 ${this.workerId}: 샵 ID ${shopId}의 배송 정보 처리 완료 (샌드박스 모드: ${config.shopee.isSandbox})`);
      
      // 재고 업데이트 작업 추가
      await inventoryQueue.add(
        'update-inventory',
        {
          shopId: shop.shop_id,
          orderSns: orderSns
        },
        { priority: 5 }
      );
      
      return { success: true };
    } catch (error) {
      logger.error(`워커 ${this.workerId}: 배송 정보 처리 작업 중 오류:`, error);
      throw error;
    } finally {
      this.activeJobs--;
      this.status = this.activeJobs === 0 ? 'idle' : this.status;
      this.reportStatus();
    }
  }

  /**
   * 재고 업데이트 작업 프로세서
   */
  async processInventoryUpdate(job) {
    const { shopId, orderSns } = job.data;
    
    try {
      this.activeJobs++;
      this.status = 'updating-inventory';
      this.reportStatus();
      
      logger.info(`워커 ${this.workerId}: 샵 ID ${shopId}의 재고 업데이트 시작 (주문 ${orderSns.length}개) (샌드박스 모드: ${config.shopee.isSandbox})`);
      
      // 샵 정보 조회
      let shop;
      try {
        shop = await shopRepository.getShopById(shopId);
        
        // 샵을 찾을 수 없는 경우 활성 샵 목록에서 찾기
        if (!shop) {
          logger.warn(`샵 ID ${shopId}를 getShopById로 찾을 수 없어 활성 샵 목록에서 검색합니다.`);
          const activeShops = await shopRepository.getActiveShops(config.shopee.isSandbox);
          shop = activeShops.find(s => s.shop_id === shopId || s.shop_id.toString() === shopId.toString());
        }
      } catch (error) {
        logger.error(`getShopById 메서드 실행 중 오류:`, error);
        
        // getShopById 메서드 실패 시 활성 샵 목록에서 찾기
        logger.info(`활성 샵 목록에서 샵 ID ${shopId}를 검색합니다 (샌드박스 모드: ${config.shopee.isSandbox}).`);
        const activeShops = await shopRepository.getActiveShops(config.shopee.isSandbox);
        shop = activeShops.find(s => s.shop_id === shopId || s.shop_id.toString() === shopId.toString());
      }
      
      if (!shop) {
        throw new Error(`샵 ID ${shopId}를 찾을 수 없습니다 (샌드박스 모드: ${config.shopee.isSandbox}).`);
      }
      
      // TODO: 재고 업데이트 로직 구현
      // 주문에서 구매된 상품 정보 가져와서 재고 차감 처리
      
      logger.info(`워커 ${this.workerId}: 샵 ID ${shopId}의 재고 업데이트 완료 (샌드박스 모드: ${config.shopee.isSandbox})`);
      
      return { success: true };
    } catch (error) {
      logger.error(`워커 ${this.workerId}: 재고 업데이트 작업 중 오류:`, error);
      throw error;
    } finally {
      this.activeJobs--;
      this.status = this.activeJobs === 0 ? 'idle' : this.status;
      this.reportStatus();
    }
  }

  /**
   * 정기 상태 보고 설정
   */
  setupStatusReporting() {
    // 10초마다 상태 보고
    setInterval(() => {
      this.reportStatus();
    }, 10000);
  }

  /**
   * 워커 프로세스 초기화
   */
  async init() {
    try {
      logger.info(`워커 ${this.workerId} 초기화 중... (PID: ${process.pid})`);
      
      // 큐 처리기 등록
      // 주문 수집 작업 처리기
      orderCollectionQueue.process('collect-shop-orders', 
        config.scheduler.concurrency,
        this.processOrderCollection.bind(this)
      );
      
      orderCollectionQueue.process('manual-order-collect', 
        config.scheduler.concurrency,
        this.processOrderCollection.bind(this)
      );
      
      // 주문 세부 정보 작업 처리기
      orderDetailQueue.process('process-order-details',
        config.scheduler.concurrency,
        this.processOrderDetails.bind(this)
      );
      
      // 배송 정보 작업 처리기
      shipmentInfoQueue.process('process-shipment-info',
        config.scheduler.concurrency,
        this.processShipmentInfo.bind(this)
      );
      
      // 재고 업데이트 작업 처리기
      // inventoryQueue.process('update-inventory',
      //   config.scheduler.concurrency,
      //   this.processInventoryUpdate.bind(this)
      // );
      
      // 상태 보고 설정
      this.setupStatusReporting();
      
      logger.info(`워커 ${this.workerId} 초기화 완료 (PID: ${process.pid})`);
    } catch (error) {
      logger.error(`워커 ${this.workerId} 초기화 중 오류:`, error);
      process.exit(1);
    }
  }
}

// 워커 프로세스 시작
if (!cluster.isMaster) {
  const worker = new Worker();
  worker.init().catch(err => {
    logger.error('워커 초기화 실패:', err);
    process.exit(1);
  });
  
  // 종료 이벤트 핸들링
  process.on('SIGINT', () => {
    logger.info(`워커 ${worker.workerId} 종료 중...`);
    process.exit(0);
  });
  
  process.on('SIGTERM', () => {
    logger.info(`워커 ${worker.workerId} 종료 중...`);
    process.exit(0);
  });
} else {
  // 단일 프로세스 모드에서도 워커 초기화
  logger.info('단일 프로세스 모드에서 워커 초기화 중...');
  const worker = new Worker();
  worker.init().catch(err => {
    logger.error('워커 초기화 실패:', err);
    process.exit(1);
  });
  
  // 종료 이벤트 핸들링
  process.on('SIGINT', () => {
    logger.info(`워커 ${worker.workerId} 종료 중...`);
    process.exit(0);
  });
  
  process.on('SIGTERM', () => {
    logger.info(`워커 ${worker.workerId} 종료 중...`);
    process.exit(0);
  });
}

module.exports = Worker; 