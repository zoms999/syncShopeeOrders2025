const winston = require('winston');
const { format, createLogger, transports } = winston;
const path = require('path');
require('winston-daily-rotate-file');

// 순환 참조를 안전하게 처리하는 함수
const safeStringify = (obj) => {
  if (obj === null || obj === undefined) {
    return '';
  }
  
  // Error 객체 특수 처리
  if (obj instanceof Error) {
    return obj.stack || obj.message;
  }
  
  try {
    const cache = new Set();
    return JSON.stringify(obj, (key, value) => {
      if (typeof value === 'object' && value !== null) {
        // 순환 참조 감지
        if (cache.has(value)) {
          return '[Circular Reference]';
        }
        cache.add(value);
      }
      return value;
    }, 2);
  } catch (err) {
    return `[Unserializable Object: ${err.message}]`;
  }
};

// 로그 포맷 정의
const logFormat = format.combine(
  format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
  format.printf(({ timestamp, level, message, ...meta }) => {
    return `${timestamp} [${level.toUpperCase()}]: ${message} ${
      Object.keys(meta).length ? safeStringify(meta) : ''
    }`;
  })
);

// 일별 로테이션 파일 트랜스포트 설정
const dailyRotateFileTransport = new transports.DailyRotateFile({
  filename: path.join('logs', 'application-%DATE%.log'),
  datePattern: 'YYYY-MM-DD',
  maxSize: '20m',
  maxFiles: '14d',
  format: logFormat
});

// 로거 생성
const logger = createLogger({
  level: process.env.NODE_ENV === 'production' ? 'info' : 'debug',
  format: logFormat,
  transports: [
    new transports.Console({
      format: format.combine(
        format.colorize(),
        logFormat
      )
    }),
    dailyRotateFileTransport
  ]
});

module.exports = logger; 