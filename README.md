# 쇼피 주문 동기화 시스템

쇼피(Shopee) 플랫폼의 주문 데이터를 수집하고 재고를 관리하는 분산 처리 시스템입니다.

## 시스템 아키텍처

본 시스템은 분산 처리를 지원하는 마스터-워커 아키텍처로 설계되었습니다.

### 주요 구성 요소

1. **마스터 프로세스**: 
   - 작업 스케줄링 및 분배
   - API 엔드포인트 제공
   - 워커 프로세스 관리
   - 상태 모니터링

2. **워커 프로세스**:
   - 주문 데이터 수집 및 처리
   - 배송 정보 처리
   - 재고 업데이트

3. **메시지 큐**:
   - 작업 분배
   - 실패 처리 및 재시도
   - 작업 우선순위 관리

4. **데이터베이스**:
   - 주문 및 상품 데이터 저장
   - 설정 및 상태 저장

## 기능

- 쇼피 샵별 주문 데이터 자동 수집
- 주문 상세 정보 및 배송 정보 수집
- 재고 자동 업데이트
- 실시간 모니터링
- 수동 주문 수집 기능
- 오류 복구 및 재시도 메커니즘

## 설치 및 실행

### 필수 요구사항

- Node.js 14 이상
- Redis 서버
- PostgreSQL 데이터베이스

### 환경 설정

`.env` 파일을 생성하고 다음 설정을 구성하세요:

```
# 데이터베이스 설정
DB_ENGINE=postgresql
DB_HOST=localhost
DB_PORT=5432
DB_NAME=shopee_orders
DB_USER=postgres
DB_PASSWORD=your_password
DB_SCHEMA=public
DB_POOL_SIZE=10

# Redis 설정
REDIS_HOST=localhost
REDIS_PORT=6379
REDIS_PASSWORD=
REDIS_DB=0

# 클러스터 설정
CLUSTER_ENABLED=true
CLUSTER_WORKERS=4

# 쇼피 API 설정
SHOPEE_API_URL=https://partner.shopeemobile.com/api/v2
SHOPEE_PARTNER_ID=your_partner_id
SHOPEE_PARTNER_KEY=your_partner_key

# API 서버 설정
API_PORT=3000
API_HOST=localhost

# 스케줄러 설정
CRON_EXPRESSION=*/10 * * * *
MAX_RETRY_COUNT=3
ORDER_BATCH_SIZE=50
JOB_CONCURRENCY=5

# 로깅 설정
LOG_LEVEL=info
LOG_DIR=logs
```

### 설치 및 실행

```bash
# 의존성 설치
npm install

# 단일 프로세스 모드로 실행
npm start

# 클러스터 모드로 실행 (마스터 + 워커)
npm run master

# 워커만 실행
npm run worker
```

## API 엔드포인트

### 상태 확인

```
GET /health
```

### 큐 상태 확인

```
GET /queue/status
```

### 특정 샵 주문 수집 수동 실행

```
POST /order/collect/:shopId
```

### 시스템 정보

```
GET /system/info
```

## 분산 처리 아키텍처

### 클러스터 모드

클러스터 모드에서는 마스터 프로세스가 워커 프로세스들을 관리하고 작업을 분배합니다. 각 워커는 독립적으로 작업을 처리하며, Redis 기반 큐를 통해 작업이 분배됩니다.

### 작업 처리 과정

1. 마스터 프로세스는 cron 설정에 따라 주기적으로 주문 수집 작업을 스케줄링합니다.
2. 활성화된 쇼피 샵 목록을 조회하여 각 샵별로 주문 수집 작업을 큐에 추가합니다.
3. 워커 프로세스들은 큐에서 작업을 가져와 처리합니다:
   - 주문 목록 수집
   - 주문 세부 정보 처리
   - 배송 정보 처리
   - 재고 업데이트
4. 작업 결과는 데이터베이스에 저장되고, 실패한 작업은 자동으로 재시도됩니다.

### 장애 복구

- 워커 프로세스 장애 시 마스터가 자동으로 재시작
- 작업 실패 시 지수 백오프(exponential backoff) 전략으로 재시도
- 마스터 프로세스 장애 시 모든 워커는 현재 작업을 완료 후 종료

## 모니터링

시스템은 다음과 같은 모니터링 지표를 제공합니다:

- 활성 워커 수
- 큐 상태 (대기, 처리 중, 완료, 실패)
- 각 샵별 주문 수집 통계
- 시스템 자원 사용량

## 라이센스

MIT 