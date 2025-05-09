const logger = require('./utils/logger');
const cluster = require('cluster');
const config = require('./config/config');

/**
 * 애플리케이션 메인 함수
 */
async function main() {
  try {
    logger.info('쇼피 주문 데이터 수집 및 재고 관리 서비스 시작');
    
    // 클러스터 모드 여부 확인
    if (config.cluster.enabled) {
      // 클러스터 모드로 실행
      logger.info(`클러스터 모드로 실행 (워커 수: ${config.cluster.workers})`);
      
      if (cluster.isMaster) {
        // 마스터 프로세스 실행
        require('./master');
        
        logger.info('마스터 프로세스가 시작되었습니다.');
      } else {
        // 워커 프로세스 실행
        require('./worker');
      }
    } else {
      // 단일 프로세스 모드로 실행
      logger.info('단일 프로세스 모드로 실행');
      
      // 로컬 스케줄러 시작
      const orderScheduler = require('./schedules/orderScheduler');
      orderScheduler.start();
      
      // API 서버 구성 및 시작
      const express = require('express');
      const app = express();
      
      app.use(express.json());
      
      // 상태 확인 API
      app.get('/health', (req, res) => {
        res.json({
          status: 'ok',
          mode: 'standalone',
          timestamp: new Date().toISOString()
        });
      });
      
      // 작업 큐 상태 확인 API
      app.get('/queue/status', async (req, res) => {
        try {
          const { orderCollectionQueue, orderDetailQueue, shipmentInfoQueue, inventoryQueue } = require('./queues/orderQueue');
          
          const [waitingCollection, activeCollection, completedCollection, failedCollection] = await Promise.all([
            orderCollectionQueue.getWaitingCount(),
            orderCollectionQueue.getActiveCount(),
            orderCollectionQueue.getCompletedCount(),
            orderCollectionQueue.getFailedCount()
          ]);
          
          const [waitingDetail, activeDetail, completedDetail, failedDetail] = await Promise.all([
            orderDetailQueue.getWaitingCount(),
            orderDetailQueue.getActiveCount(),
            orderDetailQueue.getCompletedCount(),
            orderDetailQueue.getFailedCount()
          ]);
          
          const [waitingShipment, activeShipment, completedShipment, failedShipment] = await Promise.all([
            shipmentInfoQueue.getWaitingCount(),
            shipmentInfoQueue.getActiveCount(),
            shipmentInfoQueue.getCompletedCount(),
            shipmentInfoQueue.getFailedCount()
          ]);
          
          const [waitingInventory, activeInventory, completedInventory, failedInventory] = await Promise.all([
            inventoryQueue.getWaitingCount(),
            inventoryQueue.getActiveCount(),
            inventoryQueue.getCompletedCount(),
            inventoryQueue.getFailedCount()
          ]);
          
          res.json({
            status: 'ok',
            orderCollectionQueue: {
              waiting: waitingCollection,
              active: activeCollection,
              completed: completedCollection,
              failed: failedCollection
            },
            orderDetailQueue: {
              waiting: waitingDetail,
              active: activeDetail,
              completed: completedDetail,
              failed: failedDetail
            },
            shipmentInfoQueue: {
              waiting: waitingShipment,
              active: activeShipment,
              completed: completedShipment,
              failed: failedShipment
            },
            inventoryQueue: {
              waiting: waitingInventory,
              active: activeInventory,
              completed: completedInventory,
              failed: failedInventory
            }
          });
        } catch (error) {
          logger.error('큐 상태 조회 중 오류:', error);
          res.status(500).json({ error: '큐 상태 조회 실패' });
        }
      });
      
      // 워커 상태 확인 API
      app.get('/worker/status', (req, res) => {
        try {
          // 단일 프로세스 모드에서는 자기 자신이 워커입니다.
          res.json({
            status: 'ok',
            workers: [{
              id: 0,
              pid: process.pid,
              status: 'running',
              mode: 'standalone',
              uptime: Math.floor(process.uptime()),
              memory: Math.round(process.memoryUsage().rss / (1024 * 1024))
            }]
          });
        } catch (error) {
          logger.error('워커 상태 조회 중 오류:', error);
          res.status(500).json({ error: '워커 상태 조회 실패' });
        }
      });
      
      // 특정 샵 수동 주문 수집 API
      app.post('/order/collect/:shopId', async (req, res) => {
        const { shopId } = req.params;
        
        try {
          const { orderCollectionQueue } = require('./queues/orderQueue');
          
          // 주문 수집 작업 큐에 추가
          await orderCollectionQueue.add(
            'manual-order-collect',
            { shopId, manual: true },
            { priority: 1 } // 높은 우선순위
          );
          
          res.json({
            status: 'ok',
            message: `샵 ID ${shopId}의 주문 수집 작업이 큐에 추가되었습니다.`
          });
        } catch (error) {
          logger.error(`샵 ID ${shopId} 주문 수집 요청 중 오류:`, error);
          res.status(500).json({ error: '주문 수집 작업 큐 추가 실패' });
        }
      });
      
      // 주문 상세 정보 조회 API
      app.get('/order/:orderId', async (req, res) => {
        const { orderId } = req.params;
        const orderRepository = require('./db/orderRepository');
        
        try {
          // UUID 형식인지 확인
          const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(orderId);
          
          let result;
          if (isUuid) {
            // UUID 형식이면 ID로 조회
            result = await orderRepository.getOrderDetail(orderId, null);
          } else {
            // 아니면 주문번호로 조회
            result = await orderRepository.getOrderDetail(null, orderId);
          }
          
          if (!result) {
            return res.status(404).json({
              status: 'error',
              message: `주문 정보를 찾을 수 없습니다: ${orderId}`
            });
          }
          
          res.json({
            status: 'ok',
            data: result
          });
        } catch (error) {
          logger.error(`주문 상세 정보 조회 중 오류:`, error);
          res.status(500).json({
            status: 'error',
            message: `주문 상세 정보 조회 실패: ${error.message}`
          });
        }
      });
      
      // API 서버 시작
      app.listen(config.api.port, config.api.host, () => {
        logger.info(`API 서버가 http://${config.api.host}:${config.api.port} 에서 실행 중입니다.`);
      });
      
      logger.info('스케줄러와 API 서버가 성공적으로 시작되었습니다.');
    }
    
    // 프로세스 종료 이벤트 핸들링
    process.on('SIGINT', handleShutdown);
    process.on('SIGTERM', handleShutdown);
  } catch (error) {
    logger.error('애플리케이션 시작 중 오류 발생:', error);
    process.exit(1);
  }
}

/**
 * 프로세스 종료 핸들러
 */
async function handleShutdown() {
  logger.info('종료 신호를 받았습니다. 애플리케이션을 안전하게 종료합니다...');
  
  // Redis 및 큐 연결 종료
  try {
    const { closeQueues } = require('./queues/orderQueue');
    await closeQueues();
  } catch (err) {
    logger.error('큐 연결 종료 중 오류:', err);
  }
  
  // 스케줄러 종료
  try {
    const orderScheduler = require('./schedules/orderScheduler');
    orderScheduler.stop();
  } catch (err) {
    logger.error('스케줄러 종료 중 오류:', err);
  }
  
  // 3초 후 종료
  setTimeout(() => {
    logger.info('모든 자원이 정리되었습니다. 프로세스를 종료합니다.');
    process.exit(0);
  }, 3000);
}

// 애플리케이션 시작
main().catch(err => {
  logger.error('예기치 않은 오류가 발생했습니다:', err);
  process.exit(1);
}); 