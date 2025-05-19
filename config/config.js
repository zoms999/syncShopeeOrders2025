require('dotenv').config();

module.exports = {
  db: {
    engine: process.env.DB_ENGINE || 'postgresql',
    host: process.env.DB_HOST || 'aws-0-ap-northeast-2.pooler.supabase.com',
    port: parseInt(process.env.DB_PORT || '6543'),
    database: process.env.DB_NAME || 'postgres',
    user: process.env.DB_USER || 'postgres.muaojilpekefgeurwgxo',
    password: process.env.DB_PASSWORD || 'djfTlrn!333',
    schema: process.env.DB_SCHEMA || 'public'
  },
  redis: {
    host: process.env.REDIS_HOST || 'localhost',
    port: parseInt(process.env.REDIS_PORT || '6379'),
    password: process.env.REDIS_PASSWORD || '',
    db: parseInt(process.env.REDIS_DB || '0')
  },
  cluster: {
    enabled: process.env.CLUSTER_ENABLED === 'true',
    workers: parseInt(process.env.CLUSTER_WORKERS || '0') || require('os').cpus().length
  },
  supabase: {
    url: process.env.NEXT_PUBLIC_SUPABASE_URL || 'https://muaojilpekefgeurwgxo.supabase.co',
    anonKey: process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im11YW9qaWxwZWtlZmdldXJ3Z3hvIiwicm9sZSI6ImFub24iLCJpYXQiOjE3MzE5ODE3MzQsImV4cCI6MjA0NzU1NzczNH0.NwQJDyenEEMaM3WldoIgXbxTkxX8i7BhdSj14NvosJQ'
  },
  shopee: {
    apiUrl: process.env.SHOPEE_API_URL || 'https://partner.shopeemobile.com/api/v2',
    partnerId: process.env.SHOPEE_PARTNER_ID || '846699',
    partnerKey: process.env.SHOPEE_PARTNER_KEY || '4b474b776956466853504f584166537975734a77457253696644527a66786469',
    isSandbox: process.env.SHOPEE_IS_SANDBOX === 'false' || false
    //apiUrl: process.env.SHOPEE_API_URL || 'https://partner.test-stable.shopeemobile.com/api/v2',
    //partnerId: process.env.SHOPEE_PARTNER_ID || '845287',
    //partnerKey: process.env.SHOPEE_PARTNER_KEY || '5ae2984701425c51b55677af960865033de58383eca67eebcc0b9399719cd474',
    //isSandbox: process.env.SHOPEE_IS_SANDBOX === 'true' || true  // 샌드박스 모드 설정 (기본값: true)
  },
  scheduler: {
    cronExpression: process.env.CRON_EXPRESSION || '*/10 * * * *',
    maxRetryCount: parseInt(process.env.MAX_RETRY_COUNT || '3'),
    batchSize: parseInt(process.env.ORDER_BATCH_SIZE || '50'),
    concurrency: parseInt(process.env.JOB_CONCURRENCY || '5')
  },
  api: {
    port: parseInt(process.env.API_PORT || '3002'),
    host: process.env.API_HOST || 'localhost'
  }
}; 