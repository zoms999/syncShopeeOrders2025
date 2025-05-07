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
        SELECT ss.*, cp.id as platform_id, cp.companyid 
        FROM public.shopee_shop ss
        JOIN public.company_platform cp ON ss.platform_id = cp.id
        WHERE ss.id = $1 AND ss.deleted IS NULL AND cp.isactive = true
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
      
      // company_id 확인 (디버깅용)
      logger.debug(`샵 ID ${shop.shop_id}의 company_id: ${validShop.companyid}`);

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
    
    // shop 객체에서 이미 조회된 company_id 사용
    const companyId = shop.companyid;
    
    if (!companyId) {
      logger.error(`샵 ID ${shop.id}의 company_id가 없습니다.`);
      throw new Error(`company_id 정보 없음`);
    }
    
    logger.debug(`샵 ID ${shop.id}의 company_id: ${companyId} 사용`);
    
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
              
              // 송장번호 확인 로그 추가
              if (shipmentMap[orderSn] && shipmentMap[orderSn].tracking_number) {
                logger.info(`주문 ${orderSn} 저장 전 송장번호 확인: ${shipmentMap[orderSn].tracking_number}`);
              } else {
                logger.warn(`주문 ${orderSn}의 송장번호 정보 없음`);
              }
              
              try {
                // 주문 저장 (중복인 경우 업데이트) - company_id는 company_platform 테이블에서 조회한 값 사용
                const savedOrder = await orderRepository.upsertOrder(formattedOrder, companyId, shop.shop_id, tx);
                
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
    const batchSize = 50; // API 호출 최적화를 위한 배치 크기
    const orderSnBatches = []; // 배치 처리를 위한 주문번호 배열
    
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
          
          // 기본 배송 정보 매핑 생성
          for (const shipmentOrder of shipmentOrders) {
            // 물류 추적 정보 기본값 설정
            shipmentMap[shipmentOrder.order_sn] = {
              tracking_number: shipmentOrder.package_number,
              shipping_carrier: null,
              shipping_carrier_name: null,
              estimated_shipping_fee: 0,
              actual_shipping_cost: 0,
              histories: []
            };
            
            // 배치 처리를 위해 주문번호 저장
            orderSnBatches.push(shipmentOrder.order_sn);
          }
          
          // 배치 크기 단위로 대량 추적 정보 가져오기
          if (orderSnBatches.length >= batchSize || !shipmentResponse.response.more) {
            await this._processTrackingInfoBatch(shop, orderSnBatches, shipmentMap);
            orderSnBatches.length = 0; // 배열 비우기
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
    
    // 남은 주문에 대한 추적 정보 처리
    if (orderSnBatches.length > 0) {
      await this._processTrackingInfoBatch(shop, orderSnBatches, shipmentMap);
    }
    
    logger.info(`샵 ID ${shop.shop_id}의 배송 정보 총 ${totalShipments}개 조회 완료`);
    return shipmentMap;
  }
  
  /**
   * 배치 방식으로 주문 추적 정보 처리
   * @private
   * @param {Object} shop - 샵 정보
   * @param {Array} orderSns - 주문번호 배열
   * @param {Object} shipmentMap - 배송 정보 맵 (참조로 전달)
   */
  async _processTrackingInfoBatch(shop, orderSns, shipmentMap) {
    if (orderSns.length === 0) return;
    
    logger.debug(`샵 ID ${shop.shop_id}의 주문 ${orderSns.length}개에 대한 대량 추적 정보 조회 시작`);
    
    try {
      // 대량 추적 정보 조회 (배치 처리)
      const batchOrderSns = [...orderSns]; // 복사본 생성
      const massTrackingResponse = await shopeeApi.getMassTrackingInfo(
        shop.access_token,
        shop.shop_id,
        batchOrderSns
      );
      
      if (massTrackingResponse.response && 
          massTrackingResponse.response.response && 
          massTrackingResponse.response.response.tracking_list) {
        
        const trackingList = massTrackingResponse.response.response.tracking_list;
        logger.info(`샵 ID ${shop.shop_id}의 대량 추적 정보 ${trackingList.length}개 조회 성공`);
        
        // 각 추적 정보 처리
        for (const trackingInfo of trackingList) {
          if (!trackingInfo.order_sn || !shipmentMap[trackingInfo.order_sn]) continue;
          
          // 배송 정보 업데이트
          shipmentMap[trackingInfo.order_sn] = {
            ...shipmentMap[trackingInfo.order_sn],
            tracking_number: trackingInfo.tracking_number || shipmentMap[trackingInfo.order_sn].tracking_number,
            shipping_carrier: trackingInfo.logistics_channel_id || shipmentMap[trackingInfo.order_sn].shipping_carrier,
            shipping_carrier_name: trackingInfo.logistics_channel_name || shipmentMap[trackingInfo.order_sn].shipping_carrier_name
          };
          
          // 송장번호 로그 추가
          logger.info(`송장번호 업데이트: 주문 ${trackingInfo.order_sn}, 송장번호: ${shipmentMap[trackingInfo.order_sn].tracking_number}`);
          
          // 추적 번호가 있는 경우에만 상세 정보 조회
          if (trackingInfo.tracking_number) {
            const trackingNumber = trackingInfo.tracking_number;
            try {
              // 상세 배송 추적 정보 조회
              const detailedResponse = await shopeeApi.getDetailedTrackingInfo(
                shop.access_token,
                shop.shop_id,
                trackingNumber
              );
              
              if (detailedResponse.response && 
                  detailedResponse.response.response && 
                  detailedResponse.response.response.tracking_info) {
                
                const detailedInfo = detailedResponse.response.response;
                
                // 배송 이력 정보 추출
                if (detailedInfo.tracking_info && detailedInfo.tracking_info.length > 0) {
                  shipmentMap[trackingInfo.order_sn].histories = detailedInfo.tracking_info.map(info => ({
                    tracking_no: trackingNumber,
                    tracking_date: info.update_time || Math.floor(Date.now() / 1000),
                    status: info.logistics_status || 'UNKNOWN',
                    location: info.description || 'Unknown'
                  }));
                }
              }
              
              // API 호출 제한 고려 (0.2초 대기)
              await new Promise(resolve => setTimeout(resolve, 200));
            } catch (detailError) {
              logger.warn(`샵 ID ${shop.shop_id}의 주문 ${trackingInfo.order_sn} 상세 추적 정보 조회 실패: ${detailError.message}`);
            }
          }
        }
      } else {
        logger.warn(`샵 ID ${shop.shop_id}의 대량 추적 정보 응답 없음`);
      }
    } catch (batchError) {
      logger.error(`샵 ID ${shop.shop_id}의 대량 추적 정보 조회 실패: ${batchError.message}`);
      
      // 배치 처리 실패 시 개별 처리 시도
      logger.info(`샵 ID ${shop.shop_id}의 개별 추적 정보 조회로 대체 시도`);
      
      for (const orderSn of orderSns) {
        if (!shipmentMap[orderSn]) continue;
        
        try {
          // 개별 주문에 대한 물류 추적 정보 조회
          const trackingResponse = await shopeeApi.getTrackingInfo(
            shop.access_token,
            shop.shop_id,
            orderSn
          );
          
          if (trackingResponse.response && trackingResponse.response.response) {
            const trackingInfo = trackingResponse.response.response;
            
            // 추적 정보 업데이트
            shipmentMap[orderSn] = {
              ...shipmentMap[orderSn],
              tracking_number: trackingInfo.tracking_number || shipmentMap[orderSn].tracking_number,
              shipping_carrier: trackingInfo.logistics_channel_id || shipmentMap[orderSn].shipping_carrier,
              shipping_carrier_name: trackingInfo.logistics_channel_name || shipmentMap[orderSn].shipping_carrier_name
            };
          }
          
          // API 호출 제한 고려 (0.2초 대기)
          await new Promise(resolve => setTimeout(resolve, 200));
        } catch (singleError) {
          logger.warn(`샵 ID ${shop.shop_id}의 주문 ${orderSn} 개별 추적 정보 조회 실패: ${singleError.message}`);
        }
      }
    }
  }
}

module.exports = new OrderService(); 