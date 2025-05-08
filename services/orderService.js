const logger = require('../utils/logger');
const shopeeApi = require('./shopeeApi');
const orderRepository = require('../db/orderRepository');
const config = require('../config/config');
const db = require('../db/db'); // DB 모듈 임포트
const { v4: uuidv4 } = require('uuid');

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
        const utcYesterday = new Date(utcToday.getTime() - 5 * 60 * 60 * 1000);

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
    
    logger.debug(`샵 ID ${shop.shop_id}의 주문 ${orderSns.length}개에 대한 추적 정보 조회 시작`);
    
    // 개별 처리를 위한 지연 시간 설정 (API 제한 고려)
    const delayBetweenRequests = 500; // 0.5초
    let successCount = 0;
    let failCount = 0;
    let updateCount = 0;
    
    // DB 트랜잭션을 사용하지 않고 개별 저장 (안정성 향상)
    const batchSize = 10; // 10개 단위로 중간 저장
    const updatedOrders = [];
    
    // 특정 문제 주문번호를 위한 추가 로깅
    const specificOrderSn = '2505077ACBDK2R';
    
    // 모든 주문에 대해 개별적으로 조회
    for (let i = 0; i < orderSns.length; i++) {
      const orderSn = orderSns[i];
      if (!shipmentMap[orderSn]) continue;
      
      // 특정 주문번호에 대한 추가 로깅
      const isSpecificOrder = (orderSn === specificOrderSn);
      if (isSpecificOrder) {
        logger.info(`특정 주문번호 ${specificOrderSn} 처리 시작 - 현재 shipmentMap 정보:`, 
          JSON.stringify(shipmentMap[orderSn]));
      }
      
      try {
        // 개별 주문에 대한 물류 추적 정보 조회
        logger.debug(`주문 ${orderSn}의 송장번호 조회 시작`);
        
        // API 호출 타임아웃 설정 (15초)
        const apiTimeout = 15000;
        
        // 패키지 번호 조회 (C# 코드 참고)
        let packageNumber = null;
        
        // 패키지 번호 정보 조회 (로컬 변수 사용)
        try {
          // 주문 번호로 주문 ID 조회
          const orderResult = await db.oneOrNone(
            `SELECT id FROM public.toms_shopee_order WHERE order_num = $1 AND platform = 'shopee'`,
            [orderSn]
          );
          
          if (orderResult && orderResult.id) {
            // toms_shopee_package 테이블이 없으므로 대신 shipmentMap에서 패키지 정보를 사용
            // 또는 다른 관련 테이블에서 정보를 가져올 수 있음
            // 현재는 패키지 번호 없이 진행
            packageNumber = null;
            logger.debug(`주문 ${orderSn}의 패키지 번호: 설정되지 않음`);
          }
        } catch (dbError) {
          logger.warn(`주문 ${orderSn}의 패키지 번호 조회 중 오류: ${dbError.message}`);
        }
        
        // API 호출 Promise 생성 - 패키지 번호가 있으면 함께 전달
        const trackingPromise = shopeeApi.getTrackingInfo(
          shop.access_token,
          shop.shop_id,
          orderSn,
          packageNumber
        );
        
        // Promise.race로 타임아웃 처리
        const trackingResponse = await Promise.race([
          trackingPromise,
          new Promise((_, reject) => 
            setTimeout(() => reject(new Error(`송장번호 조회 API 호출 타임아웃 (주문: ${orderSn})`)), apiTimeout)
          )
        ]).catch(err => {
          logger.warn(`송장번호 조회 API 호출 중 오류 발생 (주문: ${orderSn}): ${err.message}`);
          return { response: null };
        });
        
        if (isSpecificOrder) {
          logger.info(`특정 주문번호 ${specificOrderSn} API 응답:`, 
            JSON.stringify(trackingResponse));
        }
        
        if (trackingResponse.response && trackingResponse.response.response) {
          const trackingInfo = trackingResponse.response.response;
          
          // 송장번호 확인
          const trackingNumber = trackingInfo.tracking_number || null;
          
          if (isSpecificOrder) {
            logger.info(`특정 주문번호 ${specificOrderSn}의 송장번호: ${trackingNumber}`);
          }
          
          // 배송 정보 업데이트
          shipmentMap[orderSn] = {
            ...shipmentMap[orderSn],
            tracking_number: trackingNumber,
            first_mile_tracking_number: trackingInfo.first_mile_tracking_number || null,
            last_mile_tracking_number: trackingInfo.last_mile_tracking_number || null,
            plp_number: trackingInfo.plp_number || null,
            package_number: packageNumber
          };
          
          // 송장번호 로그 추가
          if (trackingNumber) {
            logger.info(`송장번호 업데이트 성공: 주문 ${orderSn}, 송장번호: ${trackingNumber}, 패키지번호: ${packageNumber || 'N/A'}`);
            successCount++;
            updatedOrders.push({ 
              orderSn, 
              trackingNumber, 
              packageNumber
            });
            
            // 송장번호가 있는 경우에만 상세 추적 정보 조회
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
                  shipmentMap[orderSn].histories = detailedInfo.tracking_info.map(info => ({
                    tracking_no: trackingNumber,
                    tracking_date: info.update_time || Math.floor(Date.now() / 1000),
                    status: info.logistics_status || 'UNKNOWN',
                    location: info.description || 'Unknown'
                  }));
                  
                  logger.debug(`주문 ${orderSn}의 배송 이력 정보 ${detailedInfo.tracking_info.length}개 조회 성공`);
                }
              }
            } catch (detailError) {
              logger.warn(`샵 ID ${shop.shop_id}의 주문 ${orderSn} 상세 추적 정보 조회 실패: ${detailError.message}`);
            }
          } else {
            logger.warn(`송장번호 없음: 주문 ${orderSn}`);
            failCount++;
          }
        } else {
          logger.warn(`주문 ${orderSn}의 송장번호 조회 응답 없음`);
          failCount++;
        }
        
        // 일정 개수마다 중간 저장 (안정성 향상)
        if (updatedOrders.length >= batchSize) {
          await this._saveTrackingNumbers(shop, updatedOrders);
          updateCount += updatedOrders.length;
          updatedOrders.length = 0;
          logger.info(`중간 저장 완료: ${updateCount}개 주문의 송장번호 DB 저장 완료`);
        }
        
        // API 호출 제한 고려 (요청 간 지연 적용)
        await new Promise(resolve => setTimeout(resolve, delayBetweenRequests));
      } catch (error) {
        logger.error(`샵 ID ${shop.shop_id}의 주문 ${orderSn} 송장번호 조회 실패: ${error.message}`);
        failCount++;
        
        // 실패해도 계속 진행 (다음 주문 처리)
        await new Promise(resolve => setTimeout(resolve, delayBetweenRequests));
      }
    }
    
    // 남은 주문 정보 저장
    if (updatedOrders.length > 0) {
      await this._saveTrackingNumbers(shop, updatedOrders);
      updateCount += updatedOrders.length;
    }
    
    logger.info(`샵 ID ${shop.shop_id}의 송장번호 조회 완료 - 성공: ${successCount}개, 실패: ${failCount}개, DB 저장: ${updateCount}개, 총 처리: ${orderSns.length}개`);
  }
  
  /**
   * 송장번호 DB 저장
   * @private
   * @param {Object} shop - 샵 정보
   * @param {Array} updatedOrders - 업데이트된 주문 정보 배열
   */
  async _saveTrackingNumbers(shop, updatedOrders) {
    if (updatedOrders.length === 0) return;
    
    logger.debug(`${updatedOrders.length}개 주문의 송장번호 DB 저장 시작`);
    
    for (const order of updatedOrders) {
      try {
        // 특정 주문번호에 대한 추가 로깅
        const isSpecificOrder = (order.orderSn === '2505077ACBDK2R');
        if (isSpecificOrder) {
          logger.info(`특정 주문번호 ${order.orderSn} DB 저장 시작 - 송장번호: ${order.trackingNumber}`);
        }
        
        // 주문 번호로 주문 ID 조회
        const orderResult = await db.oneOrNone(
          `SELECT id FROM public.toms_shopee_order WHERE order_num = $1 AND platform = 'shopee'`,
          [order.orderSn]
        );
        
        if (!orderResult || !orderResult.id) {
          logger.warn(`주문번호 ${order.orderSn}에 해당하는 주문 정보를 찾을 수 없음`);
          continue;
        }
        
        const orderId = orderResult.id;
        
        if (isSpecificOrder) {
          logger.info(`특정 주문번호 ${order.orderSn} 주문 ID 조회 성공: ${orderId}`);
        }
        
        // 물류 정보 조회
        const logisticResult = await db.oneOrNone(
          `SELECT id, tracking_no FROM public.toms_shopee_logistic WHERE toms_order_id = $1`,
          [orderId]
        );
        
        if (!logisticResult || !logisticResult.id) {
          logger.warn(`주문 ID ${orderId}에 해당하는 물류 정보를 찾을 수 없음`);
          continue;
        }
        
        const logisticId = logisticResult.id;
        const currentTrackingNo = logisticResult.tracking_no;
        
        if (isSpecificOrder) {
          logger.info(`특정 주문번호 ${order.orderSn} 물류 ID 조회 성공: ${logisticId}, 현재 송장번호: ${currentTrackingNo || 'null'}`);
        }
        
        // 송장번호가 이미 있고 동일한 경우 스킵
        if (currentTrackingNo && currentTrackingNo === order.trackingNumber) {
          logger.debug(`주문번호 ${order.orderSn}의 송장번호가 이미 동일함 (${order.trackingNumber}), 업데이트 스킵`);
          continue;
        }
        
        try {
          // 송장번호 업데이트 - 트랜잭션 사용
          await db.tx('update-tracking-tx', async tx => {
            // 물류 정보 송장번호 업데이트
            await tx.none(
              `UPDATE public.toms_shopee_logistic SET 
                tracking_no = $1, 
                updated_at = CURRENT_TIMESTAMP 
              WHERE id = $2`,
              [order.trackingNumber, logisticId]
            );
            
            // 주문 아이템 송장번호 업데이트
            await tx.none(
              `UPDATE public.toms_shopee_order_item SET 
                tracking_no = $1, 
                updated_at = CURRENT_TIMESTAMP 
              WHERE toms_order_id = $2`,
              [order.trackingNumber, orderId]
            );
            
            // 성공 로깅
            if (isSpecificOrder) {
              logger.info(`특정 주문번호 ${order.orderSn} 트랜잭션 내 모든 업데이트 완료`);
            }
          });
          
          logger.info(`주문번호 ${order.orderSn}의 송장번호 DB 저장 성공 (송장번호: ${order.trackingNumber})`);
          
          // 특정 주문번호 추가 검증
          if (isSpecificOrder) {
            const verifyResult = await db.oneOrNone(
              `SELECT l.tracking_no, i.tracking_no as item_tracking_no 
               FROM public.toms_shopee_logistic l
               JOIN public.toms_shopee_order_item i ON l.toms_order_id = i.toms_order_id
               WHERE l.toms_order_id = $1
               LIMIT 1`,
              [orderId]
            );
            
            if (verifyResult) {
              logger.info(`특정 주문번호 ${order.orderSn} 저장 후 검증: 물류 송장번호=${verifyResult.tracking_no}, 아이템 송장번호=${verifyResult.item_tracking_no}`);
            }
          }
        } catch (txError) {
          logger.error(`주문번호 ${order.orderSn}의 송장번호 트랜잭션 실패:`, {
            message: txError.message,
            orderId,
            logisticId,
            trackingNumber: order.trackingNumber
          });
          
          // 특정 주문번호의 경우 개별 업데이트 시도
          if (isSpecificOrder) {
            try {
              logger.info(`특정 주문번호 ${order.orderSn} 개별 업데이트 시도`);
              
              // 물류 정보 송장번호 업데이트 - 직접 SQL 사용
              const logisticUpdateResult = await db.result(
                `UPDATE public.toms_shopee_logistic SET 
                  tracking_no = $1, 
                  updated_at = CURRENT_TIMESTAMP 
                WHERE id = $2`,
                [order.trackingNumber, logisticId]
              );
              
              logger.info(`물류 정보 직접 업데이트 결과: ${logisticUpdateResult.rowCount}행 영향 받음`);
              
              // UNIQUE 제약조건 확인을 위한 로그
              const tableInfoQuery = await db.any(`
                SELECT 
                  a.attname as column_name,
                  format_type(a.atttypid, a.atttypmod) as data_type,
                  a.attnotnull as is_not_null,
                  i.indisunique as is_unique
                FROM 
                  pg_index i
                JOIN 
                  pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = ANY(i.indkey)
                WHERE 
                  i.indrelid = 'public.toms_shopee_logistic'::regclass
                  AND a.attname = 'toms_order_id'
              `);
              
              logger.info(`toms_shopee_logistic 테이블 제약 조건 정보:`, JSON.stringify(tableInfoQuery));
              
              // 주문 아이템 송장번호 업데이트 - 직접 SQL 사용
              const itemsUpdateResult = await db.result(
                `UPDATE public.toms_shopee_order_item SET 
                  tracking_no = $1, 
                  updated_at = CURRENT_TIMESTAMP 
                WHERE toms_order_id = $2`,
                [order.trackingNumber, orderId]
              );
              
              logger.info(`주문 아이템 직접 업데이트 결과: ${itemsUpdateResult.rowCount}행 영향 받음`);
              
              // 검증을 위한 SQL 로그 추가
              const verifyQuery = `
                SELECT 
                  o.id as order_id, 
                  o.order_num,
                  l.id as logistic_id,
                  l.tracking_no as logistic_tracking_no,
                  COUNT(i.id) as item_count,
                  COUNT(CASE WHEN i.tracking_no = $1 THEN 1 END) as updated_items
                FROM 
                  public.toms_shopee_order o
                LEFT JOIN 
                  public.toms_shopee_logistic l ON o.id = l.toms_order_id
                LEFT JOIN 
                  public.toms_shopee_order_item i ON o.id = i.toms_order_id
                WHERE 
                  o.order_num = $2
                GROUP BY 
                  o.id, o.order_num, l.id, l.tracking_no
              `;
              
              const verifyResult = await db.oneOrNone(verifyQuery, [order.trackingNumber, order.orderSn]);
              
              if (verifyResult) {
                logger.info(`주문 ${order.orderSn} 업데이트 상태 검증:`, JSON.stringify(verifyResult));
                
                // 업데이트가 제대로 되지 않은 경우
                if (verifyResult.logistic_tracking_no !== order.trackingNumber || 
                    verifyResult.updated_items < verifyResult.item_count) {
                  
                  // 마지막 비상 수단: 직접 raw SQL 실행
                  logger.info(`최종 비상 업데이트 시도 - 모든 테이블 직접 업데이트`);
                  
                  // 물류 테이블 직접 업데이트
                  await db.none(`
                    UPDATE public.toms_shopee_logistic 
                    SET tracking_no = '${order.trackingNumber}', 
                        updated_at = CURRENT_TIMESTAMP 
                    WHERE toms_order_id = '${orderId}'
                  `);
                  
                  // 아이템 테이블 직접 업데이트
                  await db.none(`
                    UPDATE public.toms_shopee_order_item 
                    SET tracking_no = '${order.trackingNumber}', 
                        updated_at = CURRENT_TIMESTAMP 
                    WHERE toms_order_id = '${orderId}'
                  `);
                  
                  // 최종 검증
                  const finalVerify = await db.oneOrNone(verifyQuery, [order.trackingNumber, order.orderSn]);
                  logger.info(`최종 비상 업데이트 후 검증:`, JSON.stringify(finalVerify));
                }
              } else {
                logger.error(`주문 ${order.orderSn} 검증 쿼리 실패: 결과 없음`);
              }
              
              logger.info(`특정 주문번호 ${order.orderSn} 개별 업데이트 성공`);
            } catch (directError) {
              logger.error(`특정 주문번호 ${order.orderSn} 개별 업데이트 실패:`, directError);
            }
          }
        }
      } catch (error) {
        logger.error(`주문번호 ${order.orderSn}의 송장번호 DB 저장 실패:`, error);
      }
    }
  }
}

module.exports = new OrderService(); 