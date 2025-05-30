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
        SELECT ss.*, cp.id as platform_id, cp.companyid, cp.issandbox 
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

      // 샌드박스 모드 설정 (회사 설정 기준)
      shopeeApi.isSandbox = validShop.issandbox === true;
      logger.info(`샵 ID ${shop.shop_id}의 샌드박스 모드: ${shopeeApi.isSandbox}`);

      // 샵의 주문 수집 단위(분) 확인
      //const minutesToCollect = validShop.order_update_minute || 60;
      
      // 주문 수집 시간 범위 설정 (기본값: 샵 설정의 분 단위)
      //const timeFrom = Math.floor(Date.now() / 1000) - (minutesToCollect * 60);
      //const timeTo = Math.floor(Date.now() / 1000);

      const now = new Date();
      const utcToday = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
      const utcTomorrow = new Date(utcToday.getTime() + 24 * 60 * 60 * 1000);
      const utcYesterday = new Date(utcToday.getTime() - 1 * 60 * 60 * 1000);

      const timeFrom = Math.floor(utcYesterday.getTime() / 1000); // 어제 0시
      const timeTo = Math.floor(utcTomorrow.getTime() / 1000);        // 오늘 0시
      
      // 특정 주문 처리 (송장번호 문제 디버깅/해결용)
      //await this.processSpecificOrder(validShop);
      
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
          
          // 불완전한 물류 정보 보완 (송장번호 또는 배송사 정보 누락 해결)
          try {
            await this.fixIncompleteLogisticInfo(validShop);
          } catch (fixError) {
            logger.warn(`샵 ID ${validShop.shop_id}의 물류 정보 보완 중 오류 (계속 진행): ${fixError.message}`);
          }
          
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
    // stats 객체에 orderSns 배열이 없으면 초기화
    if (!stats.orderSns) {
      stats.orderSns = [];
      logger.debug('stats.orderSns 배열이 없어 초기화했습니다.');
    }
    
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
        
        // 배송 정보는 개별 주문 처리 시 getTrackingInfo API로 조회
        const shipmentMap = {};
        
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
                shipping: this._extractShippingInfo(orderDetail, orderSn),
                items: formattedItems
              };
              
              // fulfillment_flag 처리 - 열거형 값으로 변환
              if (formattedOrder.fulfillment_flag === 'fulfilled_by_cb_seller') {
                formattedOrder.fulfillment_flag = 'SELLER';
              } else if (formattedOrder.fulfillment_flag === 'fulfilled_by_shopee') {
                formattedOrder.fulfillment_flag = 'SHOPEE';
              }
              
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
   * 배치 방식으로 주문 추적 정보 처리
   * @private
   * @param {Object} shop - 샵 정보
   * @param {Array} orderSns - 주문번호 배열
   * @param {Object} shipmentMap - 배송 정보 맵 (참조로 전달)
   * @returns {Promise<Object>} - 처리 결과 통계
   */
  async _processTrackingInfoBatch(shop, orderSns, shipmentMap) {
    if (orderSns.length === 0) return { processed: 0, updated: 0 };
    
    logger.debug(`샵 ID ${shop.shop_id}의 주문 ${orderSns.length}개에 대한 추적 정보 조회 시작`);
    
    // 개별 처리를 위한 지연 시간 설정 (API 제한 고려)
    const delayBetweenRequests = 500; // 0.5초
    let successCount = 0;
    let failCount = 0;
    let updateCount = 0;
    
    // DB 트랜잭션을 사용하지 않고 개별 저장 (안정성 향상)
    const batchSize = 10; // 10개 단위로 중간 저장
    const updatedOrders = [];
    
    // 모든 주문에 대해 개별적으로 조회
    for (let i = 0; i < orderSns.length; i++) {
      const orderSn = orderSns[i];
      
      // shipmentMap에 없으면 빈 객체로 초기화
      if (!shipmentMap[orderSn]) {
        shipmentMap[orderSn] = {
          tracking_number: null,
          shipping_carrier: null,
          shipping_carrier_name: null,
          estimated_shipping_fee: 0,
          actual_shipping_cost: 0,
          histories: []
        };
      }
      
      try {
        // 개별 주문에 대한 물류 추적 정보 조회
        logger.debug(`주문 ${orderSn}의 송장번호 조회 시작`);
        
        // 주문 정보 조회 (DB)
        let orderId = null;
        let currentTrackingNo = null;
        let orderStatus = null;
        
        try {
          // 주문 번호로 주문 정보 조회
          const orderResult = await db.oneOrNone(
            `SELECT o.id, o.status, l.tracking_no 
             FROM public.toms_shopee_order o
             LEFT JOIN public.toms_shopee_logistic l ON o.id = l.toms_order_id
             WHERE o.order_num = $1 AND o.platform = 'shopee'`,
            [orderSn]
          );
          
          if (orderResult && orderResult.id) {
            orderId = orderResult.id;
            orderStatus = orderResult.status;
            currentTrackingNo = orderResult.tracking_no;
            
            // 특정 상태의 주문만 송장번호 조회 (최적화)
            const canHaveTracking = ['PROCESSED', 'SHIPPED', 'COMPLETED'].includes(orderStatus);
            if (!canHaveTracking) {
              logger.debug(`주문 ${orderSn}는 송장번호를 가질 수 없는 상태(${orderStatus})입니다.`);
              continue;
            }
          } else {
            logger.warn(`주문 ${orderSn} DB에 주문 정보가 없습니다.`);
            continue;
          }
        } catch (dbError) {
          logger.warn(`주문 ${orderSn}의 주문 정보 조회 중 오류: ${dbError.message}`);
          continue;
        }
        
        // API 호출 (C# 코드와 유사한 방식으로 처리)
        const trackingResponse = await shopeeApi.getTrackingInfo(
          shop.access_token,
          shop.shop_id,
          orderSn,
          null // package_number 필드가 없으므로 null 전달
        ).catch(err => {
          logger.warn(`송장번호 조회 API 호출 중 오류 발생 (주문: ${orderSn}): ${err.message}`);
          return null;
        });
        
        if (trackingResponse && trackingResponse.response) {
          const trackingInfo = trackingResponse.response;
          
          // 배송사 명 관련 필드 디버그 로그 추가
          logger.debug(`주문 ${orderSn} API 응답 필드 확인:`, {
            shipping_provider: trackingInfo.shipping_provider || null,
            shipping_provider_name: trackingInfo.shipping_provider_name || null,
            logistic_name: trackingInfo.logistic_name || null,
            carrier_name: trackingInfo.carrier_name || null,
            carrier: trackingInfo.carrier || null,
            logistics_channel: trackingInfo.logistics_channel || null,
            logistics_status: trackingInfo.logistics_status || null
          });
          
          // 송장번호 확인 - 다양한 필드에서 시도
          const trackingNumber = trackingInfo.tracking_number || 
                                trackingInfo.first_mile_tracking_number || 
                                trackingInfo.last_mile_tracking_number || 
                                trackingInfo.plp_number;
          
          // 배송사 명 추출
          const carrierName = trackingInfo.shipping_provider_name || 
                             trackingInfo.logistic_name || 
                             trackingInfo.carrier_name || 
                             trackingInfo.shipping_provider || 
                             trackingInfo.carrier || 
                             trackingInfo.logistics_channel || null;
          
          // 배송 정보 업데이트
          if (trackingNumber) {
            shipmentMap[orderSn] = {
              ...shipmentMap[orderSn],
              tracking_number: trackingNumber,
              shipping_carrier: trackingInfo.shipping_provider || trackingInfo.logistic_name || trackingInfo.carrier_name || trackingInfo.carrier || trackingInfo.logistics_channel || null,
              shipping_carrier_name: trackingInfo.shipping_provider_name || trackingInfo.logistic_name || trackingInfo.carrier_name || trackingInfo.shipping_provider || trackingInfo.carrier || trackingInfo.logistics_channel || null,
              estimated_shipping_fee: trackingInfo.estimated_shipping_fee || 0,
              actual_shipping_cost: trackingInfo.actual_shipping_cost || 0,
              first_mile_tracking_number: trackingInfo.first_mile_tracking_number || null,
              last_mile_tracking_number: trackingInfo.last_mile_tracking_number || null,
              plp_number: trackingInfo.plp_number || null
            };
            
            // 송장번호 로그 추가
            logger.info(`송장번호 확인: 주문 ${orderSn}, 송장번호: ${trackingNumber}, 배송사: ${shipmentMap[orderSn].shipping_carrier_name || '없음'}`);
            
            // 이미 동일한 번호가 DB에 있는지 확인 (중복 업데이트 방지)
            if (currentTrackingNo !== trackingNumber) {
              // 필수 필드 검증
              if (!orderSn || !orderId || !trackingNumber) {
                logger.error(`송장번호 업데이트 대상 추가 실패 - 필수 필드 누락:`, {
                  orderSn: orderSn || 'NULL',
                  orderId: orderId || 'NULL', 
                  trackingNumber: trackingNumber || 'NULL'
                });
                failCount++;
                continue;
              }
              
              successCount++;
              updatedOrders.push({ 
                orderSn: orderSn, 
                orderId: orderId,
                trackingNumber: trackingNumber,
                carrierName: shipmentMap[orderSn].shipping_carrier_name
              });
              
              logger.info(`송장번호 DB 업데이트 예정: 주문 ${orderSn}, 송장번호: ${trackingNumber}`);
            } else {
              logger.debug(`주문 ${orderSn}의 송장번호가 이미 DB에 동일하게 있음 (${trackingNumber})`);
            }
            
            // 송장번호가 있는 경우에만 상세 추적 정보 조회 - 선택적 기능
            try {
              // 상세 배송 추적 정보 조회
              const detailedResponse = await shopeeApi.getDetailedTrackingInfo(
                shop.access_token,
                shop.shop_id,
                trackingNumber
              );
              
              if (detailedResponse && 
                  detailedResponse.response && 
                  detailedResponse.response.tracking_info) {
                
                const detailedInfo = detailedResponse.response;
                
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
            logger.warn(`송장번호 없음: 주문 ${orderSn} (API 응답에 송장번호 없음)`);
            failCount++;
          }
        } else {
          logger.warn(`주문 ${orderSn}의 송장번호 조회 응답 없음`);
          failCount++;
        }
        
        // 일정 개수마다 중간 저장 (안정성 향상)
        if (updatedOrders.length >= batchSize) {
          const savedCount = await this._saveTrackingNumbers(shop, updatedOrders);
          updateCount += savedCount;
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
      const savedCount = await this._saveTrackingNumbers(shop, updatedOrders);
      updateCount += savedCount;
    }
    
    logger.info(`샵 ID ${shop.shop_id}의 송장번호 조회 완료 - 성공: ${successCount}개, 실패: ${failCount}개, DB 저장: ${updateCount}개, 총 처리: ${orderSns.length}개`);
    
    return { 
      processed: orderSns.length,
      updated: updateCount
    };
  }
  
  /**
   * 송장번호 DB 저장
   * @private
   * @param {Object} shop - 샵 정보
   * @param {Array} updatedOrders - 업데이트된 주문 정보 배열
   * @returns {Promise<number>} - 저장된 주문 수
   */
  async _saveTrackingNumbers(shop, updatedOrders) {
    if (updatedOrders.length === 0) return 0;
    
    logger.debug(`${updatedOrders.length}개 주문의 송장번호 DB 저장 시작`);
    
    let savedCount = 0;
    
    for (const order of updatedOrders) {
      try {
        // 필수 필드 검증
        if (!order.orderSn) {
          logger.error(`송장번호 저장 실패: 주문번호(orderSn)가 없습니다. 데이터:`, order);
          continue;
        }
        
        if (!order.orderId) {
          logger.error(`주문 ${order.orderSn}의 송장번호 저장 실패: 주문 ID(orderId)가 없습니다. 데이터:`, order);
          continue;
        }
        
        if (!order.trackingNumber) {
          logger.error(`주문 ${order.orderSn}의 송장번호 저장 실패: 송장번호(trackingNumber)가 없습니다. 데이터:`, order);
          continue;
        }
        
        // 디버그용 로그 추가
        logger.debug(`주문 ${order.orderSn} 송장번호 저장 시작`, {
          orderSn: order.orderSn,
          orderId: order.orderId,
          trackingNumber: order.trackingNumber,
          carrierName: order.carrierName || 'NULL'
        });
        
        // 트랜잭션으로 처리
        await db.tx('save-tracking-tx', async tx => {
          // 물류 정보 확인
          const logisticResult = await tx.oneOrNone(
            `SELECT id FROM public.toms_shopee_logistic WHERE toms_order_id = $1`,
            [order.orderId]
          );
          
          if (logisticResult && logisticResult.id) {
            // 기존 물류 정보에서 name 값 조회
            const existingLogistic = await tx.oneOrNone(
              `SELECT name FROM public.toms_shopee_logistic WHERE id = $1`,
              [logisticResult.id]
            );
            
            // 기존 name이 있으면 유지, 없으면 새로 설정
            const finalCarrierName = existingLogistic && existingLogistic.name 
              ? existingLogistic.name 
              : (order.carrierName || null);
            
            // 기존 물류 정보 업데이트 (name 보존)
            await tx.none(
              `UPDATE public.toms_shopee_logistic SET 
                tracking_no = $1, 
                name = $2,
                updated_at = CURRENT_TIMESTAMP 
              WHERE id = $3`,
              [order.trackingNumber, finalCarrierName, logisticResult.id]
            );
            
            logger.debug(`주문 ${order.orderSn}의 기존 물류 정보 업데이트 (물류 ID: ${logisticResult.id}, 기존 name: ${existingLogistic?.name || 'NULL'}, 최종 name: ${finalCarrierName})`);
          } else {
            // 물류 정보 신규 생성 - UUID 생성 추가
            const newLogisticId = uuidv4();
            await tx.none(
              `INSERT INTO public.toms_shopee_logistic 
                (id, toms_order_id, tracking_no, name, platform, created_at, updated_at) 
              VALUES 
                ($1, $2, $3, $4, 'shopee', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
              [newLogisticId, order.orderId, order.trackingNumber, order.carrierName || null]
            );
            
            logger.debug(`주문 ${order.orderSn}의 물류 정보 신규 생성 (물류 ID: ${newLogisticId})`);
          }
          
          // 주문 아이템 업데이트
          const updateItemsResult = await tx.result(
            `UPDATE public.toms_shopee_order_item SET 
              tracking_no = $1, 
              updated_at = CURRENT_TIMESTAMP 
            WHERE toms_order_id = $2`,
            [order.trackingNumber, order.orderId]
          );
          
          logger.debug(`주문 ${order.orderSn}의 아이템 업데이트: ${updateItemsResult.rowCount}개 행 영향`);
          
          // 주문 상태 확인 및 필요시 업데이트
          const orderStatusResult = await tx.oneOrNone(
            `SELECT status FROM public.toms_shopee_order WHERE id = $1`,
            [order.orderId]
          );
          
          if (orderStatusResult && orderStatusResult.status !== 'SHIPPED' && orderStatusResult.status !== 'COMPLETED') {
            await tx.none(
              `UPDATE public.toms_shopee_order SET 
                status = $1, 
                updated_at = CURRENT_TIMESTAMP 
              WHERE id = $2`,
              ['SHIPPED', order.orderId]
            );
            
            logger.debug(`주문 ${order.orderSn}의 상태를 'SHIPPED'로 업데이트`);
          }
        });
        
        logger.info(`주문 ${order.orderSn}의 송장번호 ${order.trackingNumber} DB 저장 성공`);
        savedCount++;
        
      } catch (error) {
        logger.error(`주문 ${order.orderSn || 'UNKNOWN'}의 송장번호 DB 저장 실패: ${error.message}`, {
          orderData: order,
          errorStack: error.stack
        });
      }
    }
    
    return savedCount;
  }
  
  /**
   * 송장번호가 있지만 DB에 업데이트되지 않은 주문 찾아서 처리
   * @private
   * @param {Object} shop - 샵 정보
   * @returns {Promise<void>}
   */
  async _processUnupdatedTrackingNumbers(shop) {
    logger.info(`[개선] 미업데이트 송장번호 처리 시작 - 샵 ID: ${shop.shop_id}`);
    
    try {
      // 1. 송장번호가 없는 발송 상태 주문 찾기
      const unupdatedOrders = await db.manyOrNone(
        `SELECT o.id, o.order_num, o.status 
         FROM public.toms_shopee_order o
         LEFT JOIN public.toms_shopee_logistic l ON o.id = l.toms_order_id
         WHERE o.platform = 'shopee'
         AND o.shop_id = $1
         AND (o.status = 'PROCESSED' OR o.status = 'SHIPPED')
         AND (l.tracking_no IS NULL OR l.tracking_no = '')`,
        [shop.shop_id]
      );
      
      if (!unupdatedOrders || unupdatedOrders.length === 0) {
        logger.info(`[개선] 미업데이트 송장번호 없음 - 모든 주문의 송장번호가 업데이트되었습니다.`);
        return;
      }
      
      logger.info(`[개선] 미업데이트 송장번호 주문 수: ${unupdatedOrders.length}개`);
      
      // 2. 각 주문 처리
      const batchSize = 10;
      let processedCount = 0;
      let updatedCount = 0;
      
      for (let i = 0; i < unupdatedOrders.length; i += batchSize) {
        const batch = unupdatedOrders.slice(i, i + batchSize);
        const updatedOrders = [];
        
        for (const order of batch) {
          processedCount++;
          
          try {
            // API 호출로 송장번호 확인
            const trackingResponse = await shopeeApi.getTrackingInfo(
              shop.access_token,
              shop.shop_id,
              order.order_num,
              null
            ).catch(err => {
              logger.warn(`미업데이트 주문 ${order.order_num} 송장번호 API 호출 오류: ${err.message}`);
              return null;
            });
            
            // 송장번호 추출
            let trackingNumber = null;
            
            if (trackingResponse && trackingResponse.response) {
              const trackingInfo = trackingResponse.response;
              
              trackingNumber = trackingInfo.tracking_number || 
                              trackingInfo.first_mile_tracking_number || 
                              trackingInfo.last_mile_tracking_number || 
                              trackingInfo.plp_number;
              
              // 배송사 명 추출
              const carrierName = trackingInfo.shipping_provider_name || 
                                 trackingInfo.logistic_name || 
                                 trackingInfo.carrier_name || 
                                 trackingInfo.shipping_provider || 
                                 trackingInfo.carrier || 
                                 trackingInfo.logistics_channel || null;
              
              if (trackingNumber) {
                logger.info(`[개선] 주문 ${order.order_num}의 누락된 송장번호 찾음: ${trackingNumber}`);
                
                // 필수 필드 검증
                if (!order.order_num || !order.id || !trackingNumber) {
                  logger.error(`[개선] 미업데이트 주문 추가 실패 - 필수 필드 누락:`, {
                    orderSn: order.order_num || 'NULL',
                    orderId: order.id || 'NULL',
                    trackingNumber: trackingNumber || 'NULL'
                  });
                  continue;
                }
                
                updatedOrders.push({
                  orderSn: order.order_num,
                  orderId: order.id,
                  trackingNumber: trackingNumber,
                  carrierName: carrierName
                });
              } else {
                logger.warn(`[개선] 주문 ${order.order_num}의 송장번호를 API에서 찾을 수 없음`);
                
                // C# 코드 참고하여 최후의 방법 - 주문번호를 송장번호로 사용
                if (order.status === 'SHIPPED') {
                  logger.info(`[개선] 발송 상태인 주문 ${order.order_num}의 주문번호를 송장번호로 사용`);
                  
                  // 필수 필드 검증
                  if (!order.order_num || !order.id) {
                    logger.error(`[개선] 미업데이트 주문 추가 실패 - 필수 필드 누락:`, {
                      orderSn: order.order_num || 'NULL',
                      orderId: order.id || 'NULL'
                    });
                    continue;
                  }
                  
                  updatedOrders.push({
                    orderSn: order.order_num,
                    orderId: order.id,
                    trackingNumber: order.order_num, // 주문번호를 송장번호로
                    carrierName: null
                  });
                }
              }
            }
          } catch (error) {
            logger.error(`미업데이트 주문 ${order.order_num} 처리 오류: ${error.message}`);
          }
          
          // API 제한 고려 - 짧은 지연
          await new Promise(resolve => setTimeout(resolve, 300));
        }
        
        // 배치 저장
        if (updatedOrders.length > 0) {
          const savedCount = await this._saveTrackingNumbers(shop, updatedOrders);
          updatedCount += savedCount;
          
          logger.info(`[개선] 미업데이트 주문 배치 처리 완료: ${savedCount}/${updatedOrders.length}개 저장됨, 진행률: ${processedCount}/${unupdatedOrders.length}`);
        }
      }
      
      logger.info(`[개선] 미업데이트 송장번호 처리 완료 - 총 처리: ${processedCount}개, 업데이트: ${updatedCount}개`);
      
    } catch (error) {
      logger.error(`[개선] 미업데이트 송장번호 처리 중 오류: ${error.message}`);
    }
  }

  /**
   * 특정 주문번호의 송장번호 문제 해결
   * @param {Object} shop - 샵 정보
   * @returns {Promise<void>} - void
   */
  async processSpecificOrder(shop) {
    // 송장번호 문제가 있는 특정 주문번호 처리
    const specificOrderSn = '25042563TEG8YN';
    logger.info(`[디버그] 특정 주문번호 ${specificOrderSn} 수동 처리 시작`);
    
    try {
      // 1. 주문 정보 조회 - 올바른 필드명 사용
      const orderResult = await db.oneOrNone(
        `SELECT id, status, action_status FROM public.toms_shopee_order WHERE order_num = $1 AND platform = 'shopee'`,
        [specificOrderSn]
      );
      
      if (!orderResult) {
        logger.warn(`[디버그] ${specificOrderSn} 주문 정보가 DB에 없습니다.`);
        return;
      }
      
      logger.info(`[디버그] ${specificOrderSn} 주문 상태: ${orderResult.status || 'NULL'}, 액션 상태: ${orderResult.action_status || 'NULL'}`);
      
      // 샌드박스 모드 설정 (회사 설정 기준)
      shopeeApi.isSandbox = shop.issandbox === true;
      logger.info(`[디버그] ${specificOrderSn} 처리를 위한 샌드박스 모드: ${shopeeApi.isSandbox}`);
      
      // 2. 직접 API 호출로
      try {
        const trackingResponse = await shopeeApi.getTrackingInfo(
          shop.access_token,
          shop.shop_id,
          specificOrderSn,
          null // package_number 필드가 없으므로 null 전달
        ).catch(err => {
          logger.error(`[디버그] ${specificOrderSn} 송장번호 API 호출 오류:`, err);
          return null;
        });
        
        logger.info(`[디버그] ${specificOrderSn} API 응답:`, 
          trackingResponse ? JSON.stringify(trackingResponse) : 'null');
        
        // 3. API 응답에서 송장번호 찾기
        let trackingNumber = null;
        
        if (trackingResponse && trackingResponse.response) {
          const trackingInfo = trackingResponse.response;
          
          // 배송사 명 관련 필드 디버그 로그 추가
          logger.debug(`주문 ${specificOrderSn} API 응답 필드 확인:`, {
            shipping_provider: trackingInfo.shipping_provider || null,
            shipping_provider_name: trackingInfo.shipping_provider_name || null,
            logistic_name: trackingInfo.logistic_name || null,
            carrier_name: trackingInfo.carrier_name || null,
            carrier: trackingInfo.carrier || null,
            logistics_channel: trackingInfo.logistics_channel || null,
            logistics_status: trackingInfo.logistics_status || null
          });
          
          // 송장번호 확인 - 다양한 필드에서 시도
          const trackingNumber = trackingInfo.tracking_number || 
                                trackingInfo.first_mile_tracking_number || 
                                trackingInfo.last_mile_tracking_number || 
                                trackingInfo.plp_number;
          
          // 배송사 명 추출
          const carrierName = trackingInfo.shipping_provider_name || 
                             trackingInfo.logistic_name || 
                             trackingInfo.carrier_name || 
                             trackingInfo.shipping_provider || 
                             trackingInfo.carrier || 
                             trackingInfo.logistics_channel || null;
          
          if (trackingNumber) {
            logger.info(`[디버그] ${specificOrderSn} 송장번호 찾음: ${trackingNumber}, 배송사: ${carrierName || '없음'}`);
            // carrierName을 orderResult에 저장
            orderResult.carrierName = carrierName;
          } else {
            logger.warn(`[디버그] ${specificOrderSn} API에서 송장번호를 찾을 수 없음`);
          }
        } else {
          logger.warn(`[디버그] ${specificOrderSn} API 응답 없음`);
        }
        
        // 4. 소포얼 도매 발송중 상태로 송장번호 직접 설정 - 최후의 방법
        if (!trackingNumber) {
          // 한국 쇼피는 주문번호가 송장번호인 경우가 많음
          trackingNumber = specificOrderSn;
          logger.info(`[디버그] ${specificOrderSn} 대안책: 주문번호를 송장번호로 사용 (${trackingNumber})`);
        }
        
        // 5. 송장번호 DB 저장
        if (trackingNumber) {
          // 필수 필드 검증
          if (!specificOrderSn || !orderResult.id || !trackingNumber) {
            logger.error(`[디버그] ${specificOrderSn} 송장번호 저장 실패 - 필수 필드 누락:`, {
              orderSn: specificOrderSn || 'NULL',
              orderId: orderResult.id || 'NULL',
              trackingNumber: trackingNumber || 'NULL'
            });
            return;
          }
          
          // 트랜잭션으로 처리
          await db.tx('save-specific-tracking', async tx => {
            // 물류 정보 확인
            const logisticResult = await tx.oneOrNone(
              `SELECT id FROM public.toms_shopee_logistic WHERE toms_order_id = $1`,
              [orderResult.id]
            );
            
            if (logisticResult) {
              // 기존 물류 정보에서 name 값 조회
              const existingLogistic = await tx.oneOrNone(
                `SELECT name FROM public.toms_shopee_logistic WHERE id = $1`,
                [logisticResult.id]
              );
              
              // 기존 name이 있으면 유지, 없으면 새로 설정
              const finalCarrierName = existingLogistic && existingLogistic.name 
                ? existingLogistic.name 
                : (orderResult.carrierName || null);
              
              // 기존 물류 정보 업데이트 (name 보존)
              await tx.none(
                `UPDATE public.toms_shopee_logistic SET 
                  tracking_no = $1, 
                  name = $2,
                  updated_at = CURRENT_TIMESTAMP 
                WHERE id = $3`,
                [trackingNumber, finalCarrierName, logisticResult.id]
              );
              
              logger.debug(`주문 ${specificOrderSn}의 기존 물류 정보 업데이트 (물류 ID: ${logisticResult.id}, 기존 name: ${existingLogistic?.name || 'NULL'}, 최종 name: ${finalCarrierName})`);
            } else {
              // 물류 정보 신규 생성 - UUID 생성 추가
              const newLogisticId = uuidv4();
              await tx.none(
                `INSERT INTO public.toms_shopee_logistic 
                  (id, toms_order_id, tracking_no, name, platform, created_at, updated_at) 
                VALUES 
                  ($1, $2, $3, $4, 'shopee', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
                [newLogisticId, orderResult.id, trackingNumber, orderResult.carrierName || null]
              );
              
              logger.debug(`주문 ${specificOrderSn}의 물류 정보 신규 생성 (물류 ID: ${newLogisticId})`);
            }
            
            // 주문 아이템 업데이트
            const updateItemsResult = await tx.result(
              `UPDATE public.toms_shopee_order_item SET 
                tracking_no = $1, 
                updated_at = CURRENT_TIMESTAMP 
              WHERE toms_order_id = $2`,
              [trackingNumber, orderResult.id]
            );
            
            logger.info(`주문 ${specificOrderSn} 주문 아이템 업데이트: ${updateItemsResult.rowCount}개 행 영향 받음`);
            
            // 주문 상태 업데이트 (필요시) - status 필드 사용
            if (orderResult.status !== 'SHIPPED' && orderResult.status !== 'COMPLETED') {
              await tx.none(
                `UPDATE public.toms_shopee_order SET 
                  status = $1, 
                  updated_at = CURRENT_TIMESTAMP 
                WHERE id = $2`,
                ['SHIPPED', orderResult.id]
              );
              
              logger.debug(`주문 ${specificOrderSn} 주문 상태를 'SHIPPED'로 업데이트`);
            }
          });
          
          // 6. 검증
          const verifyResult = await db.oneOrNone(
            `SELECT o.status, l.tracking_no, COUNT(i.id) as item_count, 
              COUNT(CASE WHEN i.tracking_no = $1 THEN 1 END) as updated_items
             FROM public.toms_shopee_order o
             LEFT JOIN public.toms_shopee_logistic l ON o.id = l.toms_order_id
             LEFT JOIN public.toms_shopee_order_item i ON o.id = i.toms_order_id
             WHERE o.order_num = $2
             GROUP BY o.status, l.tracking_no`,
            [trackingNumber, specificOrderSn]
          );
          
          if (verifyResult) {
            logger.info(`[디버그] ${specificOrderSn} 송장번호 업데이트 결과 검증:`, JSON.stringify(verifyResult));
            
            // 모든 아이템이 업데이트되었는지 확인
            if (verifyResult.tracking_no === trackingNumber && 
                verifyResult.updated_items === verifyResult.item_count) {
              logger.info(`[디버그] ${specificOrderSn} 송장번호 ${trackingNumber} 업데이트 성공!`);
            } else {
              logger.warn(`[디버그] ${specificOrderSn} 송장번호 업데이트 불완전: 물류=${verifyResult.tracking_no}, 업데이트된 아이템=${verifyResult.updated_items}/${verifyResult.item_count}`);
            }
          } else {
            logger.error(`[디버그] ${specificOrderSn} 송장번호 업데이트 검증 실패: 결과 없음`);
          }
        }
      } catch (apiError) {
        logger.error(`[디버그] ${specificOrderSn} 처리 중 API 오류:`, apiError);
      }
    } catch (dbError) {
      logger.error(`[디버그] ${specificOrderSn} 처리 중 DB 오류:`, dbError);
    }
    
    logger.info(`[디버그] 특정 주문번호 ${specificOrderSn} 수동 처리 완료`);
  }

  /**
   * 주문 상세 정보에서 배송 정보 추출
   * @private
   * @param {Object} orderDetail - 주문 상세 정보
   * @param {string} orderSn - 주문번호
   * @returns {Object|null} - 배송 정보 객체
   */
  _extractShippingInfo(orderDetail, orderSn) {
    try {
      // 디버그용 - API 응답에서 배송사 관련 필드들 확인
      logger.debug(`주문 ${orderSn}: API 응답 배송사 필드 확인`, {
        shipping_carrier: orderDetail.shipping_carrier || null,
        checkout_shipping_carrier: orderDetail.checkout_shipping_carrier || null,
        package_list_length: orderDetail.package_list ? orderDetail.package_list.length : 0,
        first_package_shipping_carrier: orderDetail.package_list && orderDetail.package_list[0] ? orderDetail.package_list[0].shipping_carrier : null
      });
      
      // 배송사 정보 추출 우선순위:
      // 1. package_list[].shipping_carrier (패키지별 배송사 - 가장 구체적)
      // 2. shipping_carrier (주문 레벨 배송사)
      // 3. checkout_shipping_carrier (체크아웃 시 선택한 배송사)
      
      let shippingCarrier = null;
      let shippingCarrierName = null;
      let trackingNumber = null;
      
      // 1. 패키지 리스트에서 배송사 정보 확인 (가장 구체적)
      if (orderDetail.package_list && orderDetail.package_list.length > 0) {
        const firstPackage = orderDetail.package_list[0];
        shippingCarrier = firstPackage.shipping_carrier || null;
        shippingCarrierName = firstPackage.shipping_carrier || null;
        // 주의: get_order_detail API에서는 실제 tracking_number가 제공되지 않음
        // package_number는 패키지 식별자이지 송장번호가 아님
        trackingNumber = null; // get_tracking_number API에서 별도로 조회해야 함
        
        if (shippingCarrierName) {
          logger.info(`주문 ${orderSn}: 패키지에서 배송사 정보 추출 성공 - ${shippingCarrierName}`);
        } else {
          logger.debug(`주문 ${orderSn}: 패키지에서 배송사 정보 없음`);
        }
        
        logger.debug(`주문 ${orderSn}: 패키지 번호 ${firstPackage.package_number || '없음'} (송장번호 아님, 패키지 식별자임)`);
      }
      
      // 2. 주문 레벨에서 배송사 정보 확인 (패키지 정보가 없는 경우)
      if (!shippingCarrier && orderDetail.shipping_carrier) {
        shippingCarrier = orderDetail.shipping_carrier;
        shippingCarrierName = orderDetail.shipping_carrier;
        
        logger.info(`주문 ${orderSn}: 주문 레벨에서 배송사 정보 추출 성공 - ${shippingCarrierName}`);
      }
      
      // 3. 체크아웃 배송사 정보 확인 (대안)
      if (!shippingCarrier && orderDetail.checkout_shipping_carrier) {
        shippingCarrier = orderDetail.checkout_shipping_carrier;
        shippingCarrierName = orderDetail.checkout_shipping_carrier;
        
        logger.info(`주문 ${orderSn}: 체크아웃에서 배송사 정보 추출 성공 - ${shippingCarrierName}`);
      }
      
      // 배송 정보 객체 생성
      const shippingInfo = {
        shipping_carrier: shippingCarrier,
        shipping_carrier_name: shippingCarrierName,
        tracking_number: trackingNumber,
        estimated_shipping_fee: parseFloat(orderDetail.estimated_shipping_fee || 0),
        actual_shipping_cost: parseFloat(orderDetail.actual_shipping_fee || 0),
        histories: []
      };
      
      // 최종 결과 로그
      if (shippingCarrierName) {
        logger.info(`주문 ${orderSn}: 배송사 정보 추출 완료 - 배송사: ${shippingCarrierName}, 송장번호: ${trackingNumber || '없음'}`);
      } else {
        logger.warn(`주문 ${orderSn}: 모든 소스에서 배송사 정보를 찾을 수 없음`);
      }
      
      return shippingInfo;
    } catch (error) {
      logger.error(`주문 ${orderSn}: 배송 정보 추출 중 오류 - ${error.message}`);
      return null;
    }
  }

  /**
   * 불완전한 물류 정보 보완 (송장번호 또는 배송사 정보 누락 해결)
   * @param {Object} shop - 샵 정보
   * @returns {Promise<void>}
   */
  async fixIncompleteLogisticInfo(shop) {
    logger.info(`[보완] 불완전한 물류 정보 보완 시작 - 샵 ID: ${shop.shop_id}`);
    
    try {
      // 1. 송장번호는 있지만 배송사 정보가 없는 레코드 조회
      const missingCarrierRecords = await db.manyOrNone(
        `SELECT l.id, l.toms_order_id, l.tracking_no, o.order_num
         FROM public.toms_shopee_logistic l
         JOIN public.toms_shopee_order o ON l.toms_order_id = o.id
         WHERE l.tracking_no IS NOT NULL 
         AND l.tracking_no != ''
         AND (l.name IS NULL OR l.name = '')
         AND o.platform = 'shopee'
         AND o.shop_id = $1`,
        [shop.shop_id]
      );
      
      // 2. 배송사 정보는 있지만 송장번호가 없는 레코드 조회
      const missingTrackingRecords = await db.manyOrNone(
        `SELECT l.id, l.toms_order_id, l.name, o.order_num
         FROM public.toms_shopee_logistic l
         JOIN public.toms_shopee_order o ON l.toms_order_id = o.id
         WHERE l.name IS NOT NULL 
         AND l.name != ''
         AND (l.tracking_no IS NULL OR l.tracking_no = '')
         AND o.platform = 'shopee'
         AND o.shop_id = $1`,
        [shop.shop_id]
      );
      
      logger.info(`[보완] 송장번호 있지만 배송사 정보 없음: ${missingCarrierRecords.length}개`);
      logger.info(`[보완] 배송사 정보 있지만 송장번호 없음: ${missingTrackingRecords.length}개`);
      
      let fixedCount = 0;
      
      // 3. 송장번호는 있지만 배송사 정보가 없는 경우 - get_order_detail API로 배송사 정보 조회
      for (const record of missingCarrierRecords.slice(0, 20)) { // 최대 20개씩 처리
        try {
          const orderDetailResponse = await shopeeApi.getOrderDetail(
            shop.access_token,
            shop.shop_id,
            [record.order_num]
          );
          
          if (orderDetailResponse.response && orderDetailResponse.response.order_list && orderDetailResponse.response.order_list.length > 0) {
            const orderDetail = orderDetailResponse.response.order_list[0];
            const shippingInfo = this._extractShippingInfo(orderDetail, record.order_num);
            
            if (shippingInfo && shippingInfo.shipping_carrier_name) {
              // 배송사 정보 업데이트
              await db.none(
                `UPDATE public.toms_shopee_logistic SET 
                  name = $1, 
                  updated_at = CURRENT_TIMESTAMP 
                WHERE id = $2`,
                [shippingInfo.shipping_carrier_name, record.id]
              );
              
              logger.info(`[보완] 주문 ${record.order_num}: 배송사 정보 추가 (${shippingInfo.shipping_carrier_name})`);
              fixedCount++;
            }
          }
          
          // API 제한 고려
          await new Promise(resolve => setTimeout(resolve, 300));
        } catch (error) {
          logger.error(`[보완] 주문 ${record.order_num}의 배송사 정보 조회 실패: ${error.message}`);
        }
      }
      
      // 4. 배송사 정보는 있지만 송장번호가 없는 경우 - get_tracking_number API로 송장번호 조회
      for (const record of missingTrackingRecords.slice(0, 20)) { // 최대 20개씩 처리
        try {
          const trackingResponse = await shopeeApi.getTrackingInfo(
            shop.access_token,
            shop.shop_id,
            record.order_num,
            null
          );
          
          if (trackingResponse && trackingResponse.response) {
            const trackingInfo = trackingResponse.response;
            const trackingNumber = trackingInfo.tracking_number || 
                                  trackingInfo.first_mile_tracking_number || 
                                  trackingInfo.last_mile_tracking_number || 
                                  trackingInfo.plp_number;
            
            if (trackingNumber) {
              // 송장번호 업데이트
              await db.none(
                `UPDATE public.toms_shopee_logistic SET 
                  tracking_no = $1, 
                  updated_at = CURRENT_TIMESTAMP 
                WHERE id = $2`,
                [trackingNumber, record.id]
              );
              
              // 주문 아이템도 함께 업데이트
              await db.none(
                `UPDATE public.toms_shopee_order_item SET 
                  tracking_no = $1, 
                  updated_at = CURRENT_TIMESTAMP 
                WHERE toms_order_id = $2`,
                [trackingNumber, record.toms_order_id]
              );
              
              logger.info(`[보완] 주문 ${record.order_num}: 송장번호 추가 (${trackingNumber})`);
              fixedCount++;
            }
          }
          
          // API 제한 고려
          await new Promise(resolve => setTimeout(resolve, 300));
        } catch (error) {
          logger.error(`[보완] 주문 ${record.order_num}의 송장번호 조회 실패: ${error.message}`);
        }
      }
      
      logger.info(`[보완] 불완전한 물류 정보 보완 완료 - 수정된 레코드: ${fixedCount}개`);
      
    } catch (error) {
      logger.error(`[보완] 불완전한 물류 정보 보완 중 오류: ${error.message}`);
    }
  }
}

module.exports = new OrderService(); 