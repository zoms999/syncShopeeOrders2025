const db = require('./db');
const logger = require('../utils/logger');
const { v4: uuidv4 } = require('uuid');

class OrderRepository {
  /**
   * 주문 정보 저장 (중복인 경우 업데이트)
   * @param {Object} orderData - 주문 데이터
   * @param {string} companyId - 회사 ID
   * @param {string} shopId - 샵 ID
   * @param {Object} tx - 트랜잭션 객체 (선택적)
   * @returns {Promise<Object>} - 저장된 주문 정보
   */
  async upsertOrder(orderData, companyId, shopId, tx) {
    // 트랜잭션 객체 또는 db 사용
    const dbOrTx = tx || db;
    
    try {
      logger.debug(`주문 저장 시작 - 주문번호: ${orderData.order_sn}, 아이템 수: ${orderData.items ? orderData.items.length : 0}`);
      
      // 주문 기본 정보 저장 (UPSERT)
      const orderId = await this._upsertOrderBasic(orderData, companyId, shopId, dbOrTx);
      
      // 주문 배송 정보 저장
      let logisticId = null;
      if (orderData.shipping) {
        logisticId = await this._upsertLogistic(orderData.shipping, orderId, dbOrTx);
        logger.debug(`주문 배송 정보 저장 완료 - 주문번호: ${orderData.order_sn}, 물류 ID: ${logisticId}`);
        
        // 배송 이력 정보 저장
        if (orderData.shipping.histories && orderData.shipping.histories.length > 0) {
          await this._upsertLogisticHistories(orderData.shipping.histories, logisticId, dbOrTx);
        }
      } else {
        // 배송 정보가 없는 경우 기본 배송 정보 생성
        logger.debug(`주문 ${orderData.order_sn}에 배송 정보 없음, 기본 배송 정보 생성`);
        
        // 먼저 이미 존재하는 물류 정보가 있는지 확인
        try {
          const existingLogistic = await dbOrTx.oneOrNone(`
            SELECT id FROM public.toms_shopee_logistic 
            WHERE toms_order_id = $1
          `, [orderId]);
          
          if (existingLogistic) {
            // 이미 존재하면 ID 반환
            logisticId = existingLogistic.id;
            logger.debug(`주문 ${orderData.order_sn}에 이미 물류 정보 존재함 - 물류 ID: ${logisticId}`);
          } else {
            // 존재하지 않으면 새로 생성
            const tempLogisticId = uuidv4();
            const result = await dbOrTx.one(`
              INSERT INTO public.toms_shopee_logistic (
                id, platform, toms_order_id, created_at, updated_at
              ) VALUES (
                $1, 'shopee', $2, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
              )
              RETURNING id
            `, [tempLogisticId, orderId]);
            
            logisticId = result.id;
            logger.debug(`주문 ${orderData.order_sn}에 기본 배송 정보 생성 완료 - 물류 ID: ${logisticId}`);
          }
        } catch (err) {
          logger.error(`기본 배송 정보 생성/조회 실패:`, err);
          throw new Error(`배송 정보 생성/조회 실패: ${err.message}`);
        }
      }
      
      // 주문 아이템 정보 저장
      if (orderData.items && orderData.items.length > 0) {
        logger.debug(`주문 아이템 저장 시작 - 주문번호: ${orderData.order_sn}, 아이템 수: ${orderData.items.length}`);
        await this._upsertOrderItems(orderData.items, orderId, companyId, dbOrTx);
        logger.debug(`주문 아이템 저장 완료 - 주문번호: ${orderData.order_sn}`);
      } else {
        logger.warn(`주문 ${orderData.order_sn}에 아이템 정보 없음`);
      }
      
      return { orderId, success: true };
    } catch (error) {
      logger.error('주문 정보 저장 실패:', {
        message: error.message,
        orderNum: orderData.order_sn || 'unknown',
        stack: error.stack ? error.stack.split('\n')[0] : 'No stack trace'
      });
      // 외부 트랜잭션이 제공된 경우 에러를 던져 트랜잭션이 롤백되도록 함
      if (tx) {
        throw error;
      }
      return { success: false, error: error.message };
    }
  }
  
  /**
   * 주문 기본 정보 저장
   * @private
   * @param {Object} orderData - 주문 데이터
   * @param {string} companyId - 회사 ID 
   * @param {string} shopId - 샵 ID
   * @param {Object} dbOrTx - DB 또는 트랜잭션 객체
   * @returns {Promise<string>} - 저장된 주문 ID
   */
  async _upsertOrderBasic(orderData, companyId, shopId, dbOrTx) {
    // 이미 주문이 존재하는지 확인
    const existingOrder = await dbOrTx.oneOrNone(
      `SELECT id FROM public.toms_shopee_order WHERE order_num = $1 AND platform = 'shopee'`,
      [orderData.order_sn]
    );
    
    const orderId = existingOrder ? existingOrder.id : uuidv4();
    
    // action_status 매핑 (C# enum ETomsOrderActionStatus에 해당)
    // 기본값은 'ORDER'로 설정 (접수 상태)
    let actionStatus = 'ORDER';
    
    // fulfillment_flag 매핑 (C# enum EShopeeFulfillmentFlag에 해당)
    // 기본값은 'SELLER'로 설정 (fulfilled_by_cb_seller)
    let fulfillmentFlag = 'SELLER';
    
    // order_status에 따라 action_status 결정
    if (orderData.order_status === 'READY_TO_SHIP') {
      actionStatus = 'READY_TO_PRINT';
    } else if (orderData.order_status === 'SHIPPED') {
      actionStatus = 'EXPORTED';
    } else if (orderData.order_status === 'CANCELLED') {
      actionStatus = 'REQUEST_CANCEL';
    }
    
    // other_status 매핑 (C# enum ETomsOrderOtherStatus에 해당)
    // 기본값은 'NONE'
    const otherStatus = 'NONE';
    
    // fulfillment_flag 매핑 - 데이터베이스에 저장할 열거형 값으로 변환
    if (orderData.fulfillment_flag === 'fulfilled_by_cb_seller') {
      fulfillmentFlag = 'SELLER';
    } else if (orderData.fulfillment_flag === 'fulfilled_by_shopee') {
      fulfillmentFlag = 'SHOPEE';
    }
    
    const query = `
      INSERT INTO public.toms_shopee_order (
        id, platform, order_num, status, action_status, other_status,
        country_code, currency, order_date, pay_date, day_to_ship,
        price, company_id, shop_id, export_declaration_no, simple_memo,
        created_at, updated_at, arrange_shipment_at, print_at,
        cancel_by, cancel_reason, fulfillment_flag, message_to_seller
      ) VALUES (
        $1, 'shopee', $2, $3, $4, $5, 
        $6, $7, $8, $9, $10, 
        $11, $12, $13, $14, $15,
        CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, $16, $17,
        $18, $19, $20, $21
      )
      ON CONFLICT (id) DO UPDATE SET
        status = $3,
        action_status = $4,
        other_status = $5,
        day_to_ship = $10,
        price = $11,
        updated_at = CURRENT_TIMESTAMP,
        arrange_shipment_at = $16,
        print_at = $17,
        cancel_by = $18,
        cancel_reason = $19,
        fulfillment_flag = $20,
        message_to_seller = $21
      RETURNING id
    `;
    
    const params = [
      orderId,
      orderData.order_sn,
      orderData.order_status,
      actionStatus, // action_status
      otherStatus, // other_status
      orderData.region || 'KR',
      orderData.currency || 'KRW',
      orderData.create_time ? new Date(orderData.create_time * 1000) : null,
      orderData.pay_time ? new Date(orderData.pay_time * 1000) : null,
      orderData.ship_by_date ? new Date(orderData.ship_by_date * 1000) : null,
      parseFloat(orderData.total_amount || 0),
      companyId,
      shopId,
      null, // export_declaration_no
      null, // simple_memo
      null, // arrange_shipment_at
      null, // print_at
      orderData.cancel_by || null,
      orderData.cancel_reason || null,
      fulfillmentFlag, // fulfillment_flag
      orderData.message_to_seller || null
    ];
    
    try {
      const result = await dbOrTx.one(query, params);
      logger.debug(`주문 기본 정보 저장 성공 (ID: ${result.id})`);
      return result.id;
    } catch (error) {
      logger.error(`주문 기본 정보 저장 실패:`, error);
      throw error; // 상위 메서드에서 처리하도록 에러를 던짐
    }
  }
  
  /**
   * 배송 정보 저장
   * @private
   * @param {Object} logisticData - 배송 데이터
   * @param {string} orderId - 주문 ID
   * @param {Object} dbOrTx - DB 또는 트랜잭션 객체
   * @returns {Promise<string>} - 저장된 배송 ID
   */
  async _upsertLogistic(logisticData, orderId, dbOrTx) {
    // 이미 배송 정보가 존재하는지 확인
    const existingLogistic = await dbOrTx.oneOrNone(
      `SELECT id FROM public.toms_shopee_logistic WHERE toms_order_id = $1`,
      [orderId]
    );
    
    const logisticId = existingLogistic ? existingLogistic.id : uuidv4();
    
    const query = `
      INSERT INTO public.toms_shopee_logistic (
        id, name, tracking_no, estimated_shipping_fee, actual_shipping_cost,
        platform, toms_order_id, created_at, updated_at
      ) VALUES (
        $1, $2, $3, $4, $5, 
        'shopee', $6, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
      )
      ON CONFLICT (toms_order_id) DO UPDATE SET
        name = $2,
        tracking_no = $3,
        estimated_shipping_fee = $4,
        actual_shipping_cost = $5,
        updated_at = CURRENT_TIMESTAMP
      RETURNING id
    `;
    
    const params = [
      logisticId,
      logisticData.shipping_carrier_name || logisticData.shipping_carrier || null,
      logisticData.tracking_number || null,
      parseFloat(logisticData.estimated_shipping_fee || 0),
      parseFloat(logisticData.actual_shipping_cost || 0),
      orderId
    ];
    
    try {
      const result = await dbOrTx.one(query, params);
      logger.debug(`배송 정보 저장 성공 (ID: ${result.id})`);
      
      // 송장번호 저장 확인 로그 추가
      logger.info(`배송 정보 저장 완료 - 주문 ID: ${orderId}, 송장번호: ${logisticData.tracking_number || '없음'}, 배송사: ${logisticData.shipping_carrier_name || logisticData.shipping_carrier || '없음'}`);
      
      return result.id;
    } catch (error) {
      logger.error(`배송 정보 저장 실패 (주문 ID: ${orderId}):`, error);
      throw error; // 상위 메서드에서 처리하도록 에러를 던짐
    }
  }
  
  /**
   * 배송 이력 정보 저장
   * @private
   * @param {Array} histories - 배송 이력 데이터 배열
   * @param {string} logisticId - 배송 ID
   * @param {Object} dbOrTx - DB 또는 트랜잭션 객체
   * @returns {Promise<Array>} - 저장된 배송 이력 ID 배열
   */
  async _upsertLogisticHistories(histories, logisticId, dbOrTx) {
    const results = [];
    
    for (const history of histories) {
      // 이력의 고유 식별을 위한 키 생성 (이력 날짜 + 상태)
      const historyKey = `${history.tracking_no}-${history.tracking_date}-${history.status}`;
      
      // 이미 이력이 존재하는지 확인
      const existingHistory = await dbOrTx.oneOrNone(
        `SELECT id FROM public.toms_shopee_logistic_history 
         WHERE toms_logistic_id = $1 
         AND tracking_no = $2 
         AND logistic_date = $3 
         AND logistic_status = $4`,
        [logisticId, history.tracking_no, new Date(history.tracking_date * 1000), history.status]
      );
      
      const historyId = existingHistory ? existingHistory.id : uuidv4();
      
      const query = `
        INSERT INTO public.toms_shopee_logistic_history (
          id, tracking_no, logistic_date, location, logistic_status,
          created_at, updated_at, toms_logistic_id
        ) VALUES (
          $1, $2, $3, $4, $5,
          CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, $6
        )
        ON CONFLICT (id) DO UPDATE SET
          location = $4,
          updated_at = CURRENT_TIMESTAMP
        RETURNING id
      `;
      
      const params = [
        historyId,
        history.tracking_no || null,
        history.tracking_date ? new Date(history.tracking_date * 1000) : null,
        history.location || null,
        history.status || 'UNKNOWN',
        logisticId
      ];
      
      try {
        const result = await dbOrTx.one(query, params);
        results.push(result.id);
        logger.debug(`배송 이력 저장 성공 (ID: ${result.id})`);
      } catch (error) {
        logger.error(`배송 이력 저장 실패 (배송 ID: ${logisticId}):`, error);
        // 이력 하나가 실패해도 다른 이력은 계속 처리
      }
    }
    
    return results;
  }
  
  /**
   * 주문 아이템 정보 저장
   * @private
   * @param {Array} items - 주문 아이템 데이터 배열
   * @param {string} orderId - 주문 ID
   * @param {string} companyId - 회사 ID
   * @param {Object} dbOrTx - DB 또는 트랜잭션 객체
   * @returns {Promise<Array>} - 저장된 주문 아이템 ID 배열
   */
  async _upsertOrderItems(items, orderId, companyId, dbOrTx) {
    const results = [];
    
    // 이 주문에 관련된 배송 정보 조회
    const logistic = await dbOrTx.oneOrNone(
      `SELECT id, tracking_no FROM public.toms_shopee_logistic WHERE toms_order_id = $1`,
      [orderId]
    );
    
    if (!logistic || !logistic.id) {
      logger.error(`주문 아이템 저장 실패: 주문 ID ${orderId}에 대한 물류 정보가 없습니다`);
      // 물류 정보가 없는 경우 임시 물류 정보 생성
      const tempLogisticId = uuidv4();
      try {
        await dbOrTx.one(`
          INSERT INTO public.toms_shopee_logistic (
            id, platform, toms_order_id, created_at, updated_at
          ) VALUES (
            $1, 'shopee', $2, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
          )
          RETURNING id
        `, [tempLogisticId, orderId]);
        
        logger.info(`주문 ID ${orderId}에 대한 임시 물류 정보 생성 성공 (ID: ${tempLogisticId})`);
      } catch (err) {
        logger.error(`임시 물류 정보 생성 실패:`, err);
        throw new Error(`물류 정보 생성 실패: ${err.message}`);
      }
    }
    
    // 다시 조회하거나 새로 생성된 값 사용
    const logisticId = logistic ? logistic.id : (await dbOrTx.one(
      `SELECT id FROM public.toms_shopee_logistic WHERE toms_order_id = $1`,
      [orderId]
    )).id;
    
    const trackingNo = logistic ? logistic.tracking_no : null;
    
    // 우선 주문 아이템 초기화
    try {
      // 아이템을 저장하기 전에 기존 아이템들을 삭제
      await dbOrTx.none(
        `DELETE FROM public.toms_shopee_order_item WHERE toms_order_id = $1`,
        [orderId]
      );
      logger.debug(`주문 ID ${orderId}의 기존 아이템 정보 삭제 완료`);
    } catch (deleteError) {
      logger.error(`주문 아이템 삭제 실패 (주문 ID: ${orderId}):`, {
        message: deleteError.message
      });
      throw deleteError;
    }
    
    for (let i = 0; i < items.length; i++) {
      const item = items[i];
      
      // 아이템 고유키 생성 (SKU + 인덱스)
      const itemKey = `${item.item_sku || 'UNKNOWN'}-${i}`;
      
      // 새로운 아이템 ID 생성
      const itemId = uuidv4();
      
      // toms_item_id는 NOT NULL 제약조건이 있으므로 임시 UUID 생성
      const tomsItemId = uuidv4();
      
      const query = `
        INSERT INTO public.toms_shopee_order_item (
          id, platform_item_id, variation_sku, promo_variation_sku, name,
          option, price, original_price, qty, weight, index,
          platform, tracking_no, toms_order_id, toms_logistic_id, toms_item_id,
          company_id, created_at, updated_at, image_url
        ) VALUES (
          $1, $2, $3, $4, $5,
          $6, $7, $8, $9, $10, $11,
          'shopee', $12, $13, $14, $15,
          $16, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, $17
        )
        RETURNING id
      `;
      
      const params = [
        itemId,
        item.item_id ? item.item_id.toString() : null,
        item.item_sku || 'UNKNOWN',
        null, // promo_variation_sku
        item.item_name || '상품명 없음',
        item.variation_name || null,
        parseFloat(item.model_discounted_price || 0),
        parseFloat(item.model_original_price || 0),
        parseInt(item.model_quantity_purchased || 1),
        parseFloat(item.weight || 0),
        i, // index
        trackingNo,
        orderId,
        logisticId,
        tomsItemId, // 임시 UUID 사용 (NOT NULL 제약조건 충족)
        companyId, // company_platform 테이블의 companyid 값
        item.image_url || null
      ];
      
      try {
        const result = await dbOrTx.one(query, params);
        results.push(result.id);
        logger.debug(`주문 아이템 저장 성공 (ID: ${result.id})`);
      } catch (error) {
        logger.error(`주문 아이템 저장 실패 (주문 ID: ${orderId}):`, {
          message: error.message,
          itemDetails: {
            orderId,
            itemSku: item.item_sku || 'UNKNOWN',
            index: i,
            logisticId
          },
          stack: error.stack ? error.stack.split('\n')[0] : 'No stack trace'
        });
        throw error; // 트랜잭션 롤백을 위해 에러 전파
      }
    }
    
    return results;
  }

  /**
   * 주문 상세 정보 조회 (스토어드 프로시저 사용)
   * @param {string|null} orderId - 주문 ID (UUID)
   * @param {string|null} orderNum - 주문 번호
   * @param {string} platform - 플랫폼 (기본값: 'shopee')
   * @returns {Promise<Object>} - 주문 상세 정보
   */
  async getOrderDetail(orderId = null, orderNum = null, platform = 'shopee') {
    try {
      // 최소한 하나의 식별자가 필요
      if (!orderId && !orderNum) {
        throw new Error('주문 ID 또는 주문 번호를 제공해야 합니다.');
      }
      
      // 스토어드 프로시저 호출
      const query = `
        SELECT * FROM public.get_order_detail(
          p_order_id := $1,
          p_order_num := $2,
          p_platform := $3
        )
      `;
      
      const result = await db.oneOrNone(query, [orderId, orderNum, platform]);
      
      if (!result) {
        logger.warn(`주문 정보를 찾을 수 없습니다: ID=${orderId || 'NULL'}, 번호=${orderNum || 'NULL'}, 플랫폼=${platform}`);
        return null;
      }
      
      // 아이템 상세 정보는 JSONB로 반환되므로 필요시 파싱
      if (result.item_details) {
        // 이미 JSON 객체로 변환되어 있을 수 있음
        if (typeof result.item_details === 'string') {
          result.item_details = JSON.parse(result.item_details);
        }
      } else {
        result.item_details = [];
      }
      
      logger.debug(`주문 상세 정보 조회 성공: ${orderNum || orderId}`);
      return result;
    } catch (error) {
      logger.error(`주문 상세 정보 조회 실패:`, error);
      throw error;
    }
  }
}

module.exports = new OrderRepository(); 