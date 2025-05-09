const cluster = require('cluster');
const os = require('os');
const express = require('express');
const logger = require('./utils/logger');
const config = require('./config/config');
const orderScheduler = require('./schedules/orderScheduler');
const { orderCollectionQueue } = require('./queues/orderQueue');

// 클러스터 모드 설정
const WORKERS_COUNT = config.cluster.workers;

/**
 * 마스터 프로세스 클래스
 */
class Master {
  constructor() {
    this.app = express();
    this.workerMap = new Map(); // 워커 정보 저장 맵
    this.setupExpress();
  }

  /**
   * Express 서버 설정
   */
  setupExpress() {
    this.app.use(express.json());

    // 상태 확인 API
    this.app.get('/health', (req, res) => {
      res.json({
        status: 'ok',
        workers: Array.from(this.workerMap.values()),
        timestamp: new Date().toISOString()
      });
    });

    // 작업 큐 상태 확인 API
    this.app.get('/queue/status', async (req, res) => {
      try {
        const [waiting, active, completed, failed] = await Promise.all([
          orderCollectionQueue.getWaitingCount(),
          orderCollectionQueue.getActiveCount(),
          orderCollectionQueue.getCompletedCount(),
          orderCollectionQueue.getFailedCount()
        ]);

        res.json({
          status: 'ok',
          orderCollectionQueue: {
            waiting,
            active,
            completed,
            failed
          }
        });
      } catch (error) {
        logger.error('큐 상태 조회 중 오류:', error);
        res.status(500).json({ error: '큐 상태 조회 실패' });
      }
    });

    // 특정 샵 수동 주문 수집
    this.app.post('/order/collect/:shopId', async (req, res) => {
      const { shopId } = req.params;
      
      try {
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

    // 시스템 정보 API
    this.app.get('/system/info', (req, res) => {
      res.json({
        cpus: os.cpus().length,
        memory: {
          total: Math.round(os.totalmem() / (1024 * 1024)) + 'MB',
          free: Math.round(os.freemem() / (1024 * 1024)) + 'MB',
          usage: Math.round((1 - os.freemem() / os.totalmem()) * 100) + '%'
        },
        uptime: Math.round(os.uptime() / 60 / 60) + 'hours',
        workers: WORKERS_COUNT,
        activeWorkers: this.workerMap.size
      });
    });
  }

  /**
   * 워커 상태 메시지 처리
   * @param {Object} worker - 워커 객체
   * @param {Object} message - 메시지 객체
   */
  handleWorkerMessage(worker, message) {
    if (message.type === 'status') {
      // 워커 상태 정보 업데이트
      this.workerMap.set(worker.id, {
        id: worker.id,
        pid: worker.process.pid,
        status: message.status,
        jobs: message.jobs,
        lastUpdate: new Date().toISOString()
      });

      logger.debug(`워커 ${worker.id} 상태 업데이트: ${message.status}, 작업수: ${message.jobs}`);
    }
  }

  /**
   * 워커 종료 핸들러
   * @param {Object} worker - 종료된 워커
   * @param {number} code - 종료 코드
   * @param {string} signal - 종료 신호
   */
  handleWorkerExit(worker, code, signal) {
    logger.warn(`워커 ${worker.id} 종료됨 (PID: ${worker.process.pid}, 코드: ${code}, 신호: ${signal})`);
    
    // 워커 맵에서 제거
    this.workerMap.delete(worker.id);
    
    // 비정상 종료 시 워커 재시작
    if (code !== 0 && !worker.exitedAfterDisconnect) {
      logger.info(`워커 ${worker.id} 재시작 중...`);
      const newWorker = cluster.fork();
      
      // 새 워커에 메시지 핸들러 설정
      newWorker.on('message', (message) => {
        this.handleWorkerMessage(newWorker, message);
      });
      
      logger.info(`새 워커 ${newWorker.id} 시작됨 (PID: ${newWorker.process.pid})`);
    }
  }

  /**
   * 클러스터 초기화
   */
  initCluster() {
    logger.info(`마스터 프로세스 시작 (PID: ${process.pid})`);
    
    // 워커 생성
    for (let i = 0; i < WORKERS_COUNT; i++) {
      const worker = cluster.fork();
      
      // 워커 메시지 핸들러 설정
      worker.on('message', (message) => {
        this.handleWorkerMessage(worker, message);
      });
      
      logger.info(`워커 ${worker.id} 시작됨 (PID: ${worker.process.pid})`);
    }
    
    // 워커 종료 이벤트 핸들러
    cluster.on('exit', (worker, code, signal) => {
      this.handleWorkerExit(worker, code, signal);
    });
  }

  /**
   * 마스터 프로세스 시작
   */
  start() {
    if (config.cluster.enabled) {
      // 클러스터 모드로 실행
      this.initCluster();
    } else {
      // 단일 프로세스 모드로 실행
      logger.info('단일 프로세스 모드로 실행 중 (클러스터 비활성화)');
      orderScheduler.start();
    }
    
    // API 서버 시작
    this.app.listen(config.api.port, config.api.host, () => {
      logger.info(`API 서버가 http://${config.api.host}:${config.api.port} 에서 실행 중입니다.`);
    });
    
    // 종료 이벤트 핸들러
    process.on('SIGINT', this.shutdown.bind(this));
    process.on('SIGTERM', this.shutdown.bind(this));
  }

  /**
   * 안전한 종료 프로세스
   */
  async shutdown() {
    logger.info('마스터 프로세스 종료 중...');
    
    // 모든 워커 종료
    if (config.cluster.enabled) {
      for (const id of Object.keys(cluster.workers)) {
        const worker = cluster.workers[id];
        logger.info(`워커 ${worker.id} 종료 중...`);
        worker.disconnect();
      }
    }
    
    // 프로세스 종료
    setTimeout(() => {
      logger.info('마스터 프로세스 종료됨');
      process.exit(0);
    }, 3000);
  }
}

// 마스터 프로세스 시작
if (cluster.isMaster) {
  const master = new Master();
  master.start();
} else {
  // 워커 프로세스는 worker.js 로직을 사용
  require('./worker');
} 