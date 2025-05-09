// 주문 동기화 작업자
const { orderSyncQueue, orderDetailQueue } = require('../queues/orderQueue');
const shopRepository = require('../db/shopRepository');
const orderRepository = require('../db/orderRepository');
const ShopeeApiService = require('../services/shopeeApi');
const logger = require('../utils/logger');
const shopeeConfig = require('../config/shopee');

/**
 * 작업자 초기화 및 처리 로직 등록
 */
function initWorker() {
  // 주문 목록 동기화 작업 처리
  orderSyncQueue.process(shopeeConfig.concurrentJobs, async (job) => {
    try {
      logger.info('주문 동기화 작업 시작', { 
        jobId: job.id,
        shopId: job.data.shopId
      });

      const { shopId } = job.data;
      const shop = await shopRepository.getShopById(shopId);

      if (!shop) {
        throw new Error(`샵 ID ${shopId}에 해당하는 상점을 찾을 수 없습니다.`);
      }

      if (!shop.is_active) {
        logger.warn('비활성화된 상점의 주문 동기화 요청 무시', { shopId });
        return { success: false, message: '비활성화된 상점' };
      }

      // 쇼피 API 서비스 인스턴스 생성
      const shopeeApi = new ShopeeApiService(
        shop.shop_id,
        shop.partner_id,
        shop.partner_key
      );

      // 날짜 범위 설정 (기본: 24시간)
      const timeRangeParams = {
        time_range_field: 'create_time',
        time_from: Math.floor((Date.now() - 24 * 60 * 60 * 1000) / 1000),
        time_to: Math.floor(Date.now() / 1000)
      };

      // 사용자 지정 날짜 범위가 있으면 사용
      if (job.data.timeFrom && job.data.timeTo) {
        timeRangeParams.time_from = job.data.timeFrom;
        timeRangeParams.time_to = job.data.timeTo;
      }

      // 상태별 주문 조회 (default: READY_TO_SHIP)
      const status = job.data.status || shopeeConfig.orderStatus.READY_TO_SHIP;

      // 주문 목록 조회
      const orderListResponse = await shopeeApi.getOrderList({
        ...timeRangeParams,
        page_size: 100,
        order_status: status
      });

      if (!orderListResponse.response || !orderListResponse.response.order_list) {
        logger.warn('주문 목록 조회 결과 없음', { shopId, status });
        return { 
          success: true, 
          message: '조회된 주문 없음', 
          count: 0 
        };
      }

      const orders = orderListResponse.response.order_list;
      logger.info('주문 목록 조회 완료', { 
        shopId, 
        count: orders.length 
      });

      // 각 주문에 대해 상세 정보 조회 작업 등록
      for (const order of orders) {
        await orderDetailQueue.add({
          shopId: shop.id,
          orderSn: order.order_sn,
          orderData: order
        }, {
          attempts: shopeeConfig.retry.attempts,
          backoff: shopeeConfig.retry.backoff
        });
      }

      // 결과 반환
      return {
        success: true,
        message: '주문 동기화 작업 완료',
        count: orders.length
      };
    } catch (error) {
      logger.error('주문 동기화 작업 실패', {
        jobId: job.id,
        error: error.message,
        shopId: job.data.shopId
      });
      throw error; // 재시도를 위해 에러를 다시 던짐
    }
  });

  // 주문 상세 정보 처리 작업
  orderDetailQueue.process(shopeeConfig.concurrentJobs, async (job) => {
    try {
      const { shopId, orderSn, orderData } = job.data;
      logger.info('주문 상세 정보 수집 시작', { shopId, orderSn });

      const shop = await shopRepository.getShopById(shopId);

      if (!shop) {
        throw new Error(`샵 ID ${shopId}에 해당하는 상점을 찾을 수 없습니다.`);
      }

      // 쇼피 API 서비스 인스턴스 생성
      const shopeeApi = new ShopeeApiService(
        shop.shop_id,
        shop.partner_id,
        shop.partner_key
      );

      // 기본 데이터가 없으면 API로 상세 정보 조회
      let orderDetail = orderData;
      if (!orderData || !orderData.order_sn) {
        const detailResponse = await shopeeApi.getOrderDetail(orderSn);
        if (!detailResponse.response || !detailResponse.response.order_list || detailResponse.response.order_list.length === 0) {
          throw new Error(`주문번호 ${orderSn}의 상세 정보를 찾을 수 없습니다.`);
        }
        orderDetail = detailResponse.response.order_list[0];
      }

      // 주문 정보 DB에 저장
      const result = await orderRepository.saveOrder(orderDetail, shopId);
      
      logger.info('주문 상세 정보 처리 완료', { 
        shopId, 
        orderSn,
        orderId: result.id
      });

      return {
        success: true,
        message: '주문 상세 정보 처리 완료',
        orderId: result.id
      };
    } catch (error) {
      logger.error('주문 상세 정보 처리 실패', {
        jobId: job.id,
        error: error.message,
        shopId: job.data.shopId,
        orderSn: job.data.orderSn
      });
      throw error; // 재시도를 위해 에러를 다시 던짐
    }
  });

  // 작업자 이벤트 리스너 설정
  [orderSyncQueue, orderDetailQueue].forEach(queue => {
    queue.on('completed', (job, result) => {
      logger.info(`${queue.name} 작업 완료`, { 
        jobId: job.id, 
        result 
      });
    });

    queue.on('failed', (job, error) => {
      logger.error(`${queue.name} 작업 실패`, { 
        jobId: job.id,
        attemptsMade: job.attemptsMade,
        error: error.message
      });
    });
  });

  logger.info('주문 동기화 작업자 초기화 완료');
}

module.exports = { initWorker }; 