const db = require('./db');
const logger = require('../utils/logger');

class ShopRepository {
  /**
   * order_update_minute가 설정된 활성화된 쇼피 샵 목록 조회
   * @returns {Promise<Array>} - 활성 쇼피 샵 목록
   */
  async getActiveShops() {
    try {
      const query = `
        SELECT ss.* 
        FROM public.shopee_shop ss
        JOIN public.company_platform cp ON ss.platform_id = cp.id
        WHERE cp.isactive = true
        AND ss.order_update_minute IS NOT NULL
        AND ss.deleted IS NULL
        AND cp.platform = 'SHOPEE'
        ORDER BY ss.shop_id
      `;
      
      return await db.any(query);
    } catch (error) {
      logger.error('활성화된 쇼피 샵 조회 실패:', error);
      throw error;
    }
  }

  /**
   * 샵의 토큰 정보 업데이트
   * @param {string} shopId - 샵 ID
   * @param {Object} tokenInfo - 토큰 정보 객체
   * @returns {Promise<Object>} - 업데이트된 샵 정보
   */
  async updateShopToken(shopId, tokenInfo) {
    try {
      const query = `
        UPDATE public.shopee_shop
        SET 
          access_token = $1,
          refresh_token = $2,
          auth_time = $3,
          expire_at = $4,
          expire_in = $5,
          token_expiry_date = to_timestamp($6),
          updated = CURRENT_TIMESTAMP
        WHERE id = $7
        RETURNING *
      `;
      
      const params = [
        tokenInfo.access_token,
        tokenInfo.refresh_token,
        new Date(),
        tokenInfo.expire,
        tokenInfo.expire_in,
        tokenInfo.expire,
        shopId
      ];
      
      return await db.one(query, params);
    } catch (error) {
      logger.error(`샵 ID ${shopId}의 토큰 업데이트 실패:`, error);
      throw error;
    }
  }
}

module.exports = new ShopRepository(); 