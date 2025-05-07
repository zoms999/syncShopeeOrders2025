const logger = require('../utils/logger');
const shopeeApi = require('./shopeeApi');
const orderRepository = require('../db/orderRepository');
const config = require('../config/config');
const db = require('../db/db'); // DB 모듈 임포트

class OrderService {
  /**
   * 주문 데이터 수집
   * @param {Object} shop - 샵 정보
   * @returns {Promise<Object>} - 수집 결과
   */
  async collectOrders(shop) {
    const MAX_RETRY = config.scheduler.maxRetryCount;
    let retryCount = 0;
    const stats = {
      total: 0,
      success: 0,
      failed: 0,
      orderSns: []
    };

    try {
        // #주석처리소스 절대 삭제하지않음.
        // const validToken = await shopeeApi.validateToken(shop);
        // if (!validToken) {
        //   logger.error(`샵 ID ${shop.shop_id}의 유효한 토큰 없음`);
        //   return { success: false, error: '유효한 토큰 없음' };
        // }

      // DB에서 직접 샵 정보를 조회
      const query = `
        SELECT * FROM public.shopee_shop
        WHERE id = $1 AND deleted IS NULL
      `;
      
      let validShop;
      try {
        validShop = await db.oneOrNone(query, [shop.id]);
      } catch (dbError) {
        logger.error(`샵 정보 조회 중 데이터베이스 오류 발생: ${dbError.message}`);
        return { success: false, error: `데이터베이스 오류: ${dbError.message}` };
      }
      
      if (!validShop || !validShop.access_token) {
        logger.error(`샵 ID ${shop.shop_id}의 유효한 토큰 없음`);
        return { success: false, error: '유효한 토큰 없음' };
      }

      // 샵의 주문 수집 단위(분) 확인
      //const minutesToCollect = validShop.order_update_minute || 60;
      
      // 주문 수집 시간 범위 설정 (기본값: 샵 설정의 분 단위)
      //const timeFrom = Math.floor(Date.now() / 1000) - (minutesToCollect * 60);
      //const timeTo = Math.floor(Date.now() / 1000);

      const now = new Date();
        const utcToday = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
        const utcYesterday = new Date(utcToday.getTime() - 24 * 60 * 60 * 1000);

        const timeFrom = Math.floor(utcYesterday.getTime() / 1000); // 어제 0시
        const timeTo = Math.floor(utcToday.getTime() / 1000);        // 오늘 0시
      
      // 주문 데이터 수집 시작
      while (retryCount <= MAX_RETRY) {
        try {
          // 주문 목록 조회
          const orderListResponse = await shopeeApi.getOrderList(
            validShop.access_token,
            validShop.shop_id,
            {
              time_range_field: 'update_time',
              time_from: timeFrom,
              time_to: timeTo,
              page_size: 100
            }
          );
          
          if (!orderListResponse.response) {
            logger.warn(`샵 ID ${validShop.shop_id}의 주문 목록 응답 없음`);
            return { success: true, stats };
          }
          
          if (!orderListResponse.response.order_list || orderListResponse.response.order_list.length === 0) {
            logger.info(`샵 ID ${validShop.shop_id}의 수집 대상 주문 없음`);
            return { success: true, stats };
          }
          
          const orders = orderListResponse.response.order_list;
          stats.total = orders.length;
          
          logger.info(`샵 ID ${validShop.shop_id}의 주문 ${orders.length}개 발견됨`);
          
          // 주문번호 목록 추출
          const orderSns = orders.map(order => order.order_sn);
          
          // 주문 세부 정보 및 배송 정보 수집 및 저장
          await this._processOrderDetails(validShop, orderSns, stats);
          
          // 성공 처리 후 반복 종료
          break;
        } catch (error) {
          retryCount++;
          
          if (retryCount > MAX_RETRY) {
            // 에러 정보 간소화하여 순환 참조 방지
            const errorInfo = {
              message: error.message,
              name: error.name
            };
            
            logger.error(`샵 ID ${validShop.shop_id}의 주문 수집 실패, 최대 재시도 횟수 초과:`, errorInfo);
            return { 
              success: false, 
              error: `최대 재시도 횟수 초과: ${error.message}`,
              stats
            };
          }
          
          // 다음 재시도까지 대기 (지수 백오프)
          const waitTime = Math.pow(2, retryCount) * 1000;
          
          // 에러 정보 간소화
          const errorInfo = {
            message: error.message,
            name: error.name
          };
          
          logger.warn(`샵 ID ${validShop.shop_id}의 주문 수집 실패, ${retryCount}번째 재시도 (${waitTime}ms 후):`, errorInfo);
          await new Promise(resolve => setTimeout(resolve, waitTime));
        }
      }
      
      return { success: true, stats };
    } catch (error) {
      // 에러 정보 간소화
      const errorInfo = {
        message: error.message,
        name: error.name
      };
      
      logger.error(`샵 ID ${shop.shop_id}의 주문 데이터 수집 실패:`, errorInfo);
      return { 
        success: false, 
        error: error.message,
        stats
      };
    }
  }
  
  /**
   * 주문 세부 정보 및 배송 정보 처리
   * @private
   * @param {Object} shop - 샵 정보
   * @param {Array} orderSns - 주문번호 배열
   * @param {Object} stats - 통계 객체
   */
  async _processOrderDetails(shop, orderSns, stats) {
    // 배치 단위로 처리 (API 제한 고려)
    const batchSize = 50;
    
    for (let i = 0; i < orderSns.length; i += batchSize) {
      const batchOrderSns = orderSns.slice(i, i + batchSize);
      
      try {
        // 주문 세부 정보 조회
        const orderDetailResponse = await shopeeApi.getOrderDetail(
          shop.access_token,
          shop.shop_id,
          batchOrderSns
        );
        
        if (!orderDetailResponse.response || !orderDetailResponse.response.order_list) {
          logger.warn(`샵 ID ${shop.shop_id}의 주문 상세 정보 없음`);
          continue;
        }
        
        const orderDetails = orderDetailResponse.response.order_list;
        logger.info(`샵 ID ${shop.shop_id}의 주문 상세 정보 ${orderDetails.length}개 조회 성공`);
        
        // 배송 정보 조회 (모든 페이지)
        const shipmentMap = await this._fetchAllShipmentInfo(shop);
        
        // 각 주문 처리 (트랜잭션 추가)
        for (const orderDetail of orderDetails) {
          try {
            const orderSn = orderDetail.order_sn;
            
            // DB 트랜잭션 시작
            logger.info(`샵 ID ${shop.shop_id}의 주문 ${orderSn} 저장 시작 (트랜잭션)`);
            await db.tx('save-order-tx', async tx => {
              // 아이템 데이터 매핑 및 필수 필드 추가
              const formattedItems = orderDetail.item_list ? orderDetail.item_list.map(item => ({
                item_id: item.item_id,
                item_sku: item.model_sku || `shopee-${item.item_id}`,
                item_name: item.item_name,
                variation_name: item.model_name,
                model_discounted_price: item.model_discounted_price,
                model_original_price: item.model_original_price,
                model_quantity_purchased: item.model_quantity_purchased,
                weight: item.weight || 0,
                image_url: item.image_info && item.image_info.image_url ? item.image_info.image_url : null
              })) : [];
              
              // 주문 데이터 포맷팅
              const formattedOrder = {
                ...orderDetail,
                shipping: shipmentMap[orderSn] || null,
                items: formattedItems
              };
              
              // 로그에 매핑된 데이터 상세 기록
              logger.debug(`주문 ${orderSn} 데이터 매핑 결과:`, {
                orderSn: orderSn,
                itemCount: formattedItems.length,
                hasShipping: shipmentMap[orderSn] ? true : false
              });
              
              try {
                // 주문 저장 (중복인 경우 업데이트)
                const savedOrder = await orderRepository.upsertOrder(formattedOrder, shop.platform_id, shop.id, tx);
                
                if (savedOrder && savedOrder.orderId) {
                  stats.success++;
                  stats.orderSns.push(orderSn);
                  logger.info(`샵 ID ${shop.shop_id}의 주문 ${orderSn} 저장 성공 (주문 ID: ${savedOrder.orderId})`);
                } else {
                  throw new Error(`주문 저장 실패: 반환된 주문 ID 없음`);
                }
                
                // 트랜잭션 성공적으로 완료
                return savedOrder;
              } catch (dbError) {
                logger.error(`주문 저장 중 데이터베이스 오류:`, {
                  message: dbError.message,
                  orderSn: orderSn,
                  error: dbError.stack ? dbError.stack.split('\n')[0] : 'No stack trace'
                });
                throw dbError; // 트랜잭션 롤백을 위해 에러 전파
              }
            });
          } catch (orderError) {
            stats.failed++;
            
            // 에러 정보 간소화
            const errorInfo = {
              message: orderError.message,
              name: orderError.name,
              stack: orderError.stack ? orderError.stack.split('\n')[0] : 'No stack trace'
            };
            
            logger.error(`샵 ID ${shop.shop_id}의 주문 ${orderDetail.order_sn} 처리 실패:`, errorInfo);
          }
        }
      } catch (batchError) {
        // 에러 정보 간소화
        const errorInfo = {
          message: batchError.message,
          name: batchError.name
        };
        
        logger.error(`샵 ID ${shop.shop_id}의 주문 배치 처리 실패:`, errorInfo);
        stats.failed += batchOrderSns.length;
      }
      
      // API 제한 고려 대기
      await new Promise(resolve => setTimeout(resolve, 500));
    }
  }
  
  /**
   * 모든 배송 정보 가져오기 (페이지네이션 처리)
   * @private
   * @param {Object} shop - 샵 정보
   * @returns {Promise<Object>} - 주문번호를 키로 하는 배송 정보 맵
   */
  async _fetchAllShipmentInfo(shop) {
    const shipmentMap = {};
    let hasMore = true;
    let cursor = "";
    let totalShipments = 0;
    
    // 모든 페이지의 배송 정보 조회
    while (hasMore) {
      try {
        // 배송 정보 조회
        const shipmentResponse = await shopeeApi.getShipmentList(
          shop.access_token,
          shop.shop_id,
          cursor
        );
        
        if (!shipmentResponse.response) {
          logger.warn(`샵 ID ${shop.shop_id}의 배송 정보 응답 없음`);
          break;
        }
        
        // 배송 정보 처리
        if (shipmentResponse.response.order_list && shipmentResponse.response.order_list.length > 0) {
          const shipmentOrders = shipmentResponse.response.order_list;
          totalShipments += shipmentOrders.length;
          
          // 배송 정보 매핑 생성
          for (const shipmentOrder of shipmentOrders) {
            // 물류 추적 정보 기본값 설정
            shipmentMap[shipmentOrder.order_sn] = {
              tracking_number: shipmentOrder.package_number,
              shipping_carrier: null,
              shipping_carrier_name: null,
              estimated_shipping_fee: 0,
              actual_shipping_cost: 0
            };
            
            try {
              // 개별 주문에 대한 물류 추적 정보 추가 조회
              const trackingResponse = await shopeeApi.getTrackingInfo(
                shop.access_token,
                shop.shop_id,
                shipmentOrder.order_sn
              );
              
              if (trackingResponse.response && trackingResponse.response.tracking_info) {
                const trackingInfo = trackingResponse.response.tracking_info;
                // 추적 정보로 업데이트
                shipmentMap[shipmentOrder.order_sn] = {
                  tracking_number: trackingInfo.tracking_number || shipmentOrder.package_number,
                  shipping_carrier: trackingInfo.logistics_channel_id || null,
                  shipping_carrier_name: trackingInfo.logistics_channel_name || null,
                  estimated_shipping_fee: trackingInfo.estimated_shipping_fee || 0,
                  actual_shipping_cost: 0
                };
              }
            } catch (trackingError) {
              logger.warn(`샵 ID ${shop.shop_id}의 주문 ${shipmentOrder.order_sn} 물류 추적 정보 조회 실패: ${trackingError.message}`);
              // 기본값 유지
            }
            
            // API 제한 고려 대기
            await new Promise(resolve => setTimeout(resolve, 200));
          }
        }
        
        // 다음 페이지 확인
        hasMore = shipmentResponse.response.more === true;
        if (hasMore) {
          cursor = shipmentResponse.response.next_cursor;
          logger.debug(`샵 ID ${shop.shop_id}의 배송 정보 다음 페이지 조회 (커서: ${cursor})`);
        }
      } catch (error) {
        logger.error(`샵 ID ${shop.shop_id}의 배송 정보 조회 실패: ${error.message}`);
        break;
      }
    }
    
    logger.info(`샵 ID ${shop.shop_id}의 배송 정보 총 ${totalShipments}개 조회 완료`);
    return shipmentMap;
  }
}

module.exports = new OrderService(); 