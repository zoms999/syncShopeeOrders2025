// 재고 관리 작업자
const { inventoryQueue } = require('../queues/orderQueue');
const shopRepository = require('../db/shopRepository');
const orderRepository = require('../db/orderRepository');
const ShopeeApiService = require('../services/shopeeApi');
const logger = require('../utils/logger');
const shopeeConfig = require('../config/shopee');

/**
 * 작업자 초기화 및 처리 로직 등록
 */
function initWorker() {
  // 재고 업데이트 작업 처리
  inventoryQueue.process(shopeeConfig.concurrentJobs, async (job) => {
    try {
      const { shopId, productUpdates } = job.data;
      logger.info('재고 업데이트 작업 시작', { 
        jobId: job.id,
        shopId,
        productCount: productUpdates.length
      });

      const shop = await shopRepository.getShopById(shopId);

      if (!shop) {
        throw new Error(`샵 ID ${shopId}에 해당하는 상점을 찾을 수 없습니다.`);
      }

      if (!shop.is_active) {
        logger.warn('비활성화된 상점의 재고 업데이트 요청 무시', { shopId });
        return { success: false, message: '비활성화된 상점' };
      }

      // 쇼피 API 서비스 인스턴스 생성
      const shopeeApi = new ShopeeApiService(
        shop.shop_id,
        shop.partner_id,
        shop.partner_key
      );

      // 재고 정보 업데이트
      const results = [];
      for (const update of productUpdates) {
        try {
          // 재고 업데이트 API 호출
          const response = await shopeeApi.updateStock({
            item_id: update.item_id,
            model_id: update.model_id,
            stock: update.stock
          });

          results.push({
            item_id: update.item_id,
            model_id: update.model_id,
            success: true,
            response
          });

          logger.info('상품 재고 업데이트 성공', {
            shopId,
            itemId: update.item_id,
            modelId: update.model_id,
            stock: update.stock
          });
        } catch (error) {
          logger.error('상품 재고 업데이트 실패', {
            shopId,
            itemId: update.item_id,
            modelId: update.model_id,
            error: error.message
          });

          results.push({
            item_id: update.item_id,
            model_id: update.model_id,
            success: false,
            error: error.message
          });
        }
      }

      // 결과 요약
      const successCount = results.filter(r => r.success).length;
      const failCount = results.length - successCount;

      return {
        success: true,
        message: '재고 업데이트 작업 완료',
        totalCount: results.length,
        successCount,
        failCount,
        results
      };
    } catch (error) {
      logger.error('재고 업데이트 작업 처리 실패', {
        jobId: job.id,
        error: error.message,
        shopId: job.data.shopId
      });
      throw error; // 재시도를 위해 에러를 다시 던짐
    }
  });

  // 판매된 상품 재고 업데이트 (주문 기반)
  async function updateStockFromOrder(order, shopId) {
    try {
      if (!order || !order.items || order.items.length === 0) {
        logger.warn('재고 업데이트를 위한 주문 아이템 정보 없음', { 
          orderSn: order.order_sn 
        });
        return { success: false, message: '주문 아이템 정보 없음' };
      }

      const shop = await shopRepository.getShopById(shopId);
      
      // 상품 업데이트 목록 생성
      const productUpdates = order.items.map(item => ({
        item_id: item.item_id,
        model_id: item.model_id,
        stock: -1 * item.quantity // 주문량만큼 재고 감소
      }));

      // 재고 업데이트 작업 추가
      const job = await inventoryQueue.add({
        shopId,
        productUpdates
      }, {
        attempts: shopeeConfig.retry.attempts,
        backoff: shopeeConfig.retry.backoff
      });

      logger.info('주문 기반 재고 업데이트 작업 예약됨', { 
        jobId: job.id,
        orderSn: order.order_sn,
        itemCount: productUpdates.length
      });

      return { success: true, jobId: job.id };
    } catch (error) {
      logger.error('주문 기반 재고 업데이트 작업 추가 실패', {
        error: error.message,
        orderSn: order.order_sn,
        shopId
      });
      return { success: false, error: error.message };
    }
  }

  // 재고 조회 작업 추가
  async function addInventoryCheckJob(shopId, itemIds = []) {
    try {
      if (!itemIds || itemIds.length === 0) {
        logger.warn('재고 조회를 위한 상품 ID 정보 없음', { shopId });
        return { success: false, message: '상품 ID 정보 없음' };
      }

      // 재고 조회 작업 추가
      const job = await inventoryQueue.add({
        shopId,
        action: 'check',
        itemIds
      }, {
        attempts: shopeeConfig.retry.attempts,
        backoff: shopeeConfig.retry.backoff
      });

      logger.info('재고 조회 작업 예약됨', { 
        jobId: job.id,
        shopId,
        itemCount: itemIds.length
      });

      return { success: true, jobId: job.id };
    } catch (error) {
      logger.error('재고 조회 작업 추가 실패', {
        error: error.message,
        shopId
      });
      return { success: false, error: error.message };
    }
  }

  // 이벤트 리스너 설정
  inventoryQueue.on('completed', (job, result) => {
    logger.info('재고 관리 작업 완료', { 
      jobId: job.id, 
      result 
    });
  });

  inventoryQueue.on('failed', (job, error) => {
    logger.error('재고 관리 작업 실패', { 
      jobId: job.id,
      attemptsMade: job.attemptsMade,
      error: error.message
    });
  });

  logger.info('재고 관리 작업자 초기화 완료');

  return {
    updateStockFromOrder,
    addInventoryCheckJob
  };
}

module.exports = { initWorker };