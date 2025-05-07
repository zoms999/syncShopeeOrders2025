# 쇼피 주문 데이터 수집 서비스

Shopee Open API를 사용하여 각 쇼피 샵의 주문, 주문 상세, 배송, 배송 이력을 **10분마다 자동 수집**하고 PostgreSQL에 저장하는 Node.js 애플리케이션입니다.

## 기능

- 활성화된 쇼피 샵에 대해 10분 간격으로 주문 데이터 자동 수집
- 샵별 `order_update_minute` 설정에 따른 수집 범위 지정
- 주문번호 기준 중복 저장 방지 (UPSERT)
- Access Token 만료 시 자동 갱신
- 실패 시 최대 3회 재시도 로직
- 모든 데이터에 타임스탬프 기록

## 아키텍처

```
shopeeOrder/
  ├── config/             # 설정 파일
  ├── db/                 # 데이터베이스 연결 및 쿼리
  ├── logs/               # 로그 파일 디렉토리
  ├── schedules/          # 스케줄러 로직
  ├── services/           # API 및 비즈니스 로직
  ├── utils/              # 유틸리티 함수
  ├── index.js            # 애플리케이션 진입점
  ├── package.json        # 프로젝트 정보 및 의존성
  └── README.md           # 프로젝트 문서
```

## 기술 스택

- Node.js
- PostgreSQL (Supabase)
- node-cron (스케줄링)
- pg-promise (DB 연결)
- axios (API 요청)
- winston (로깅)

## 설치 및 실행

### 환경 설정

1. 필요한 패키지 설치:

```bash
npm install
```

2. 환경 변수 설정:

`.env` 파일을 프로젝트 루트에 생성하고 다음 설정을 추가합니다:

```
# Supabase PostgreSQL 설정
DB_ENGINE=postgresql
DB_HOST=your-db-host
DB_PORT=6543
DB_NAME=postgres
DB_USER=your-db-user
DB_PASSWORD=your-password
DB_SCHEMA=public

# 쇼피 API 설정
SHOPEE_API_URL=https://partner.test-stable.shopeemobile.com
SHOPEE_PARTNER_ID=your-partner-id
SHOPEE_PARTNER_KEY=your-partner-key

# 스케줄러 설정
CRON_EXPRESSION="*/10 * * * *"
MAX_RETRY_COUNT=3
```

### 실행

```bash
# 일반 실행
npm start

# 개발 모드 실행 (코드 변경 시 자동 재시작)
npm run dev
```

## 작동 방식

1. 설정된 cron 표현식(`*/10 * * * *`)에 따라 10분마다 작업 실행
2. 활성화된 모든 쇼피 샵 목록 조회
3. 각 샵별로 주문 데이터 수집 작업 수행
   - 액세스 토큰 유효성 검증 및 필요시 갱신
   - 주문 목록 조회
   - 주문 상세 정보 및 배송 정보 조회
   - 데이터베이스에 저장 (중복 방지)
4. 오류 발생 시 최대 3회 재시도
5. 모든 작업의 로그 기록

## 데이터베이스 테이블

- `shopee_shop`: 쇼피 샵 정보 및 인증 토큰
- `toms_shopee_order`: 주문 기본 정보
- `toms_shopee_logistic`: 배송 정보
- `toms_shopee_logistic_history`: 배송 이력
- `toms_shopee_order_item`: 주문 아이템 정보

## 로깅

애플리케이션 로그는 `logs/` 디렉토리에 일별로 저장됩니다. 로그 파일은 다음 형식으로 생성됩니다:

```
application-YYYY-MM-DD.log
```

## 문제 해결

- **데이터베이스 연결 오류**: 환경 변수 설정 확인
- **API 인증 오류**: 액세스 토큰 및 리프레시 토큰 확인
- **API 호출 제한**: API 요청 빈도 및 제한 확인 