const logger = require('./utils/logger');
const orderScheduler = require('./schedules/orderScheduler');

/**
 * 애플리케이션 메인 함수
 */
async function main() {
  try {
    logger.info('쇼피 주문 데이터 수집 서비스 시작');
    
    // 주문 스케줄러 시작
    orderScheduler.start();
    
    // 프로세스 종료 이벤트 핸들링
    process.on('SIGINT', handleShutdown);
    process.on('SIGTERM', handleShutdown);
    
    logger.info('스케줄러가 성공적으로 시작되었습니다.');
  } catch (error) {
    logger.error('애플리케이션 시작 중 오류 발생:', error);
    process.exit(1);
  }
}

/**
 * 프로세스 종료 핸들러
 */
function handleShutdown() {
  logger.info('종료 신호를 받았습니다. 애플리케이션을 안전하게 종료합니다...');
  
  // 여기에 추가적인 정리 작업이 필요하면 구현
  
  process.exit(0);
}

// 애플리케이션 시작
main().catch(err => {
  logger.error('예기치 않은 오류가 발생했습니다:', err);
  process.exit(1);
}); 