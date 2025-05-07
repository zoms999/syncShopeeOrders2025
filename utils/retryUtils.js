const logger = require('./logger');
const config = require('../config/config');

/**
 * 작업 실패 시 재시도하는 유틸리티 함수
 * @param {Function} fn - 실행할 함수
 * @param {Array} args - 함수에 전달할 인자 배열
 * @param {Object} options - 옵션 객체
 * @param {number} options.maxRetries - 최대 재시도 횟수
 * @param {number} options.initialDelay - 초기 지연 시간 (ms)
 * @param {number} options.factor - 지연 시간 증가 계수
 * @param {Function} options.shouldRetry - 재시도 여부 결정 함수
 * @returns {Promise<*>} - 함수 실행 결과
 */
async function withRetry(fn, args = [], options = {}) {
  const maxRetries = options.maxRetries || config.scheduler.maxRetryCount || 3;
  const initialDelay = options.initialDelay || 1000;
  const factor = options.factor || 2;
  const shouldRetry = options.shouldRetry || (() => true);
  
  let lastError;
  
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      // 함수 실행
      const result = await fn(...args);
      if (attempt > 0) {
        logger.info(`함수 실행 성공 (재시도 ${attempt}/${maxRetries} 후)`);
      }
      return result;
    } catch (error) {
      lastError = error;
      
      // 재시도 여부 확인
      if (attempt === maxRetries || !shouldRetry(error)) {
        logger.error(`최대 재시도 횟수(${maxRetries}) 초과 또는 재시도 불가능한 오류:`, error);
        break;
      }
      
      // 지연 시간 계산 (지수 백오프)
      const delay = initialDelay * Math.pow(factor, attempt);
      
      logger.warn(`함수 실행 실패, ${attempt + 1}/${maxRetries} 재시도 예정 (${delay}ms 후):`, error);
      
      // 대기
      await new Promise(resolve => setTimeout(resolve, delay));
    }
  }
  
  // 모든 시도 실패
  throw lastError;
}

module.exports = {
  withRetry
}; 