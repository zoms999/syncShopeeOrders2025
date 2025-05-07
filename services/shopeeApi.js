const axios = require('axios');
const crypto = require('crypto');
const config = require('../config/config');
const logger = require('../utils/logger');
const shopRepository = require('../db/shopRepository');

class ShopeeApi {
  constructor() {
    this.apiUrl = config.shopee.apiUrl;
    this.partnerId = config.shopee.partnerId;
    this.partnerKey = config.shopee.partnerKey;
    
    // API 기본 URL 설정 - 프로덕션 서버 사용
    this.baseUrl = 'https://partner.shopeemobile.com';
    
    logger.info(`Shopee API 초기화 - 기본 URL: ${this.baseUrl}, Partner ID: ${this.partnerId}`);
  }

  /**
   * API 호출 시간값 생성
   * @returns {number} - 현재 시간 (초)
   */
  _getTimestamp() {
    return Math.floor(Date.now() / 1000);
  }

  /**
   * API 서명 생성 - Shopee API v2 방식
   * @param {string} path - API 경로 (예: /api/v2/order/get_order_list)
   * @param {number} timestamp - 타임스탬프
   * @param {string} accessToken - 액세스 토큰 (선택)
   * @param {string} shopId - 샵 ID (선택)
   * @returns {string} - 생성된 서명
   */
  _generateSignature(path, timestamp, accessToken = '', shopId = '') {
    // Shopee API v2 서명 방식: https://open.shopee.com/developer-guide/20
    
    // 기본 문자열 형식: {partner_id}{path}{timestamp}{access_token}{shop_id}
    let baseString = `${this.partnerId}${path}${timestamp}`;
    
    if (accessToken) {
      baseString += accessToken;
    }
    
    if (shopId) {
      baseString += shopId;
    }
    
    // HMAC-SHA256 해시 생성
    const sign = crypto.createHmac('sha256', this.partnerKey)
      .update(baseString)
      .digest('hex');
    
    logger.debug(`서명 생성 - 경로: ${path}, 타임스탬프: ${timestamp}, 서명 문자열: ${baseString}, 서명: ${sign}`);
    
    return sign;
  }

  /**
   * API 호출 공통 함수
   * @param {string} endpoint - API 엔드포인트
   * @param {Object} data - 요청 데이터
   * @param {string} accessToken - 액세스 토큰 (선택)
   * @param {string} shopId - 샵 ID (선택)
   * @param {string} method - HTTP 메소드 (기본: POST)
   * @returns {Promise<Object>} - API 응답
   */
  async _callApi(endpoint, data = {}, accessToken = '', shopId = '', method = 'POST') {
    // V2 API 엔드포인트 경로 구성
    const apiPath = endpoint.startsWith('/') ? endpoint : `/${endpoint}`;
    const fullPath = `/api/v2${apiPath}`;
    
    const timestamp = this._getTimestamp();
    const partnerId = parseInt(this.partnerId, 10);
    const shopIdNum = shopId ? parseInt(shopId, 10) : 0;
    
    const signature = this._generateSignature(fullPath, timestamp, accessToken, shopIdNum ? String(shopIdNum) : '');
    
    const url = `${this.baseUrl}${fullPath}`;
    logger.info(`API 호출: ${method} ${url}`);
    
    // 기본 공통 파라미터
    const commonParams = {
      partner_id: partnerId,
      timestamp,
      sign: signature
    };
    
    if (accessToken) {
      commonParams.access_token = accessToken;
    }
    
    if (shopIdNum) {
      commonParams.shop_id = shopIdNum;
    }
    
    try {
      let response;
      
      if (method.toUpperCase() === 'GET') {
        // GET 요청시 params로 전달 (URL 쿼리 파라미터)
        const getParams = {
          ...commonParams,
          ...data
        };
        
        logger.debug(`GET 요청 데이터:`, {
          url,
          params: getParams
        });
        
        response = await axios.get(url, { 
          params: getParams,
          headers: {
            'Content-Type': 'application/json'
          }
        });
      } else {
        // POST 요청시에는 공통 매개변수를 URL 쿼리 파라미터로 전달하고, 
        // 데이터는 요청 본문으로 전달
        
        logger.debug(`POST 요청 데이터:`, {
          url,
          params: commonParams,
          body: data
        });
        
        response = await axios.post(url, data, {
          params: commonParams,  // URL 쿼리 파라미터로 전달
          headers: {
            'Content-Type': 'application/json'
          }
        });
      }
      
      const responseData = response.data;
      
      // 응답 로깅 (간략화)
      logger.debug(`API 응답:`, {
        status: response.status,
        error: responseData.error || null,
        requestId: responseData.request_id || null
      });
      
      // 공통 에러 체크
      if (responseData.error) {
        logger.error(`API 에러: ${responseData.error}, 메시지: ${responseData.message}`);
        throw new Error(`API 에러: ${responseData.error}, 메시지: ${responseData.message}`);
      }
      
      return responseData;
    } catch (error) {
      // 순환 참조 문제를 방지하기 위해 에러 정보 추출
      const simplifiedError = {
        message: error.message,
        status: error.response?.status,
        statusText: error.response?.statusText,
        data: error.response?.data
      };
      
      logger.error(`API 호출 실패 (${endpoint}):`, simplifiedError);
      throw error; // 원본 에러를 그대로 던져 호출자가 처리할 수 있게 함
    }
  }
  
  /**
   * 액세스 토큰 발급 받기
   * @param {string} code - 인증 코드
   * @returns {Promise<Object>} - 토큰 정보
   */
  async getAccessToken(code) {
    logger.info(`액세스 토큰 발급 요청 - 인증 코드: ${code}`);
    
    return await this._callApi('/auth/token/get', {
      code,
    }, '', '', 'POST');
  }
  
  /**
   * 액세스 토큰 새로고침
   * @param {string} refreshToken - 리프레시 토큰
   * @param {string} shopId - 샵 ID
   * @returns {Promise<Object>} - 새 토큰 정보
   */
  async refreshAccessToken(refreshToken, shopId) {
    logger.info(`액세스 토큰 갱신 요청 - 샵 ID: ${shopId}`);
    
    return await this._callApi('/auth/access_token/get', {
      refresh_token: refreshToken,
    }, '', shopId, 'POST');
  }
  
  /**
   * 주문 목록 가져오기
   * @param {string} accessToken - 액세스 토큰
   * @param {string} shopId - 샵 ID
   * @param {Object} params - 추가 파라미터
   * @returns {Promise<Object>} - 주문 목록
   */
  async getOrderList(accessToken, shopId, params = {}) {
    // API 필수 매개변수
    const requestParams = {
      // Shopee API 필수 매개변수
      time_range_field: params.time_range_field || 'create_time',
      time_from: params.time_from || Math.floor(Date.now() / 1000) - (30 * 60), // 기본 30분 전
      time_to: params.time_to || Math.floor(Date.now() / 1000),
      page_size: params.page_size || 100,
      cursor: params.cursor || '',
      
      // 선택적 매개변수
      order_status: params.order_status || null,
      response_optional_fields: params.response_optional_fields || 'order_status'
    };
    
    // 값이 null인 매개변수 제거
    Object.keys(requestParams).forEach(key => {
      if (requestParams[key] === null) {
        delete requestParams[key];
      }
    });
    
    logger.info(`주문 목록 조회 요청 - 샵 ID: ${shopId}, 시간범위: ${requestParams.time_from} ~ ${requestParams.time_to}`);
    
    // get_order_list는 GET 메서드로 호출
    return await this._callApi('/order/get_order_list', requestParams, accessToken, shopId, 'GET');
  }
  
  /**
   * 주문 상세 가져오기
   * @param {string} accessToken - 액세스 토큰
   * @param {string} shopId - 샵 ID
   * @param {Array} orderSns - 주문번호 배열
   * @returns {Promise<Object>} - 주문 상세
   */
  async getOrderDetail(accessToken, shopId, orderSns) {
    logger.info(`주문 상세 정보 조회 요청 - 샵 ID: ${shopId}, 주문번호: ${orderSns.join(', ')}`);
    
    // 주문 상세 조회는 GET 메서드 사용 (Shopee API v2 문서 기준)
    // 모든 필요한 필드를 지정하여 응답에 포함되도록 함
    return await this._callApi('/order/get_order_detail', {
      order_sn_list: orderSns.join(','), // GET 요청에서는 배열이 아닌 쉼표로 구분된 문자열로 전달
      response_optional_fields: [
        'buyer_user_id', 'buyer_username', 'estimated_shipping_fee',
        'recipient_address', 'actual_shipping_fee', 'goods_to_declare',
        'note', 'note_update_time', 'item_list', 'pay_time', 'dropshipper',
        'credit_card_number', 'dropshipper_phone', 'split_up', 'buyer_cancel_reason',
        'cancel_by', 'cancel_reason', 'actual_shipping_fee_confirmed', 'buyer_cpf_id',
        'fulfillment_flag', 'pickup_done_time', 'package_list',
        'shipping_carrier', 'payment_method', 'total_amount', 'buyer_username',
        'invoice_data', 'checkout_shipping_carrier', 'reverse_shipping_fee',
        'order_chargeable_weight', 'order_remark'
      ].join(',')
    }, accessToken, shopId, 'GET');
  }
  
  /**
   * 배송 정보 가져오기
   * @param {string} accessToken - 액세스 토큰
   * @param {string} shopId - 샵 ID
   * @param {string} cursor - 페이지네이션 커서 (선택적)
   * @returns {Promise<Object>} - 배송 정보
   */
  async getShipmentList(accessToken, shopId, cursor = "") {
    logger.info(`배송 정보 조회 요청 - 샵 ID: ${shopId}, 커서: ${cursor}`);
    
    // v2.order.get_shipment_list API 사용 (GET 메서드)
    // 페이지네이션을 위한 cursor 파라미터 지원
    return await this._callApi('/order/get_shipment_list', {
      page_size: 100,  // 최대 결과 개수
      cursor: cursor
    }, accessToken, shopId, 'GET');
  }
  
  /**
   * 주문 물류 추적 정보 가져오기
   * @param {string} accessToken - 액세스 토큰
   * @param {string} shopId - 샵 ID
   * @param {string} orderSn - 주문번호
   * @returns {Promise<Object>} - 물류 추적 정보
   */
  async getTrackingInfo(accessToken, shopId, orderSn) {
    logger.info(`물류 추적 정보 조회 요청 - 샵 ID: ${shopId}, 주문번호: ${orderSn}`);
    
    // /logistics/tracking_number/get_mass 대신 올바른 엔드포인트 사용
    // 단일 주문의 추적 번호 조회
    return await this._callApi('/logistics/get_tracking_number', {
      order_sn: orderSn
    }, accessToken, shopId, 'GET');
  }
  
  /**
   * 주문 추적 상세 정보 가져오기
   * @param {string} accessToken - 액세스 토큰
   * @param {string} shopId - 샵 ID
   * @param {string} trackingNumber - 추적 번호
   * @returns {Promise<Object>} - 추적 상세 정보
   */
  async getDetailedTrackingInfo(accessToken, shopId, trackingNumber) {
    logger.info(`물류 추적 상세 정보 조회 요청 - 샵 ID: ${shopId}, 추적번호: ${trackingNumber}`);
    
    // 추적 상세 정보 조회
    return await this._callApi('/logistics/get_tracking_info', {
      tracking_number: trackingNumber
    }, accessToken, shopId, 'GET');
  }
  
  /**
   * 대량 주문 물류 추적 정보 가져오기
   * @param {string} accessToken - 액세스 토큰
   * @param {string} shopId - 샵 ID
   * @param {Array} orderSns - 주문번호 배열
   * @returns {Promise<Object>} - 대량 물류 추적 정보
   */
  async getMassTrackingInfo(accessToken, shopId, orderSns) {
    logger.info(`대량 물류 추적 정보 조회 요청 - 샵 ID: ${shopId}, 주문 수: ${orderSns.length}`);
    
    // 대량 추적 정보 조회
    return await this._callApi('/logistics/get_mass_tracking_number', {
      order_sn_list: orderSns.join(',')
    }, accessToken, shopId, 'GET');
  }
  
  /**
   * 액세스 토큰 검증 및 필요시 갱신
   * @param {Object} shop - 샵 정보
   * @returns {Promise<Object>} - 유효한 토큰 정보를 가진 샵 객체
   */
  async validateToken(shop) {
    try {
      // 현재 시간 (초)
      const now = Math.floor(Date.now() / 1000);
      
      // 토큰 만료 여부 확인 (5분 전에 미리 갱신)
      if (!shop.access_token || !shop.expire_at || shop.expire_at < (now + 300)) {
        logger.info(`샵 ID ${shop.shop_id}의 토큰 만료됨, 갱신 시도...`);
        
        if (!shop.refresh_token) {
          throw new Error(`샵 ID ${shop.shop_id}의 리프레시 토큰이 없음`);
        }
        
        // 리프레시 토큰으로 액세스 토큰 갱신
        const tokenResponse = await this.refreshAccessToken(shop.refresh_token, shop.shop_id);
        
        if (!tokenResponse.access_token) {
          throw new Error(`샵 ID ${shop.shop_id}의 토큰 갱신 실패`);
        }
        
        // 토큰 정보 저장
        const tokenInfo = {
          access_token: tokenResponse.access_token,
          refresh_token: tokenResponse.refresh_token,
          expire: now + tokenResponse.expire_in,
          expire_in: tokenResponse.expire_in
        };
        
        // DB에 토큰 정보 업데이트
        const updatedShop = await shopRepository.updateShopToken(shop.id, tokenInfo);
        
        // 갱신된 정보 반환
        return {
          ...shop,
          access_token: tokenResponse.access_token,
          refresh_token: tokenResponse.refresh_token,
          expire_at: now + tokenResponse.expire_in,
          expire_in: tokenResponse.expire_in
        };
      }
      
      // 토큰이 유효하면 그대로 반환
      return shop;
    } catch (error) {
      // 에러 정보 간소화
      const errorInfo = {
        message: error.message,
        name: error.name
      };
      
      logger.error(`샵 ID ${shop.shop_id}의 토큰 검증/갱신 실패:`, errorInfo);
      throw error;
    }
  }
}

module.exports = new ShopeeApi(); 