// 쇼피 API 설정
require('dotenv').config();

module.exports = {
  // 쇼피 API 버전
  apiVersion: 'v2',
  // 쇼피 API 베이스 URL
  baseUrl: process.env.SHOPEE_API_BASE_URL || 'https://partner.shopeemobile.com/api/v2',
  // 주문 상태 정의
  orderStatus: {
    UNPAID: 'UNPAID',
    READY_TO_SHIP: 'READY_TO_SHIP',
    PROCESSED: 'PROCESSED',
    SHIPPED: 'SHIPPED', 
    COMPLETED: 'COMPLETED',
    CANCELLED: 'CANCELLED',
    TO_RETURN: 'TO_RETURN',
    RETURNED: 'RETURNED'
  },
  // 주문 동기화 주기 (분 단위)
  syncIntervalMinutes: parseInt(process.env.SHOPEE_SYNC_INTERVAL_MINUTES || '15'),
  // 동시 처리 작업 수
  concurrentJobs: parseInt(process.env.SHOPEE_CONCURRENT_JOBS || '3'),
  // 재시도 설정
  retry: {
    attempts: parseInt(process.env.SHOPEE_RETRY_ATTEMPTS || '3'),
    backoff: {
      type: 'exponential',
      delay: parseInt(process.env.SHOPEE_RETRY_DELAY || '5000')
    }
  }
}; 