-- 쇼피 주문 관리 시스템 데이터베이스 스키마

-- 상점 정보 테이블
CREATE TABLE IF NOT EXISTS shops (
  id SERIAL PRIMARY KEY,
  name VARCHAR(255) NOT NULL,
  shop_id BIGINT NOT NULL,
  partner_id BIGINT NOT NULL,
  partner_key TEXT NOT NULL,
  access_token TEXT,
  refresh_token TEXT,
  expire_at TIMESTAMP,
  is_active BOOLEAN DEFAULT TRUE,
  created_at TIMESTAMP NOT NULL,
  updated_at TIMESTAMP NOT NULL,
  UNIQUE(shop_id)
);

-- 주문 정보 테이블
CREATE TABLE IF NOT EXISTS orders (
  id SERIAL PRIMARY KEY,
  order_sn VARCHAR(32) NOT NULL,
  shop_id INTEGER NOT NULL REFERENCES shops(id),
  order_status VARCHAR(32),
  order_total NUMERIC(12, 2) DEFAULT 0,
  currency VARCHAR(5),
  shipping_carrier VARCHAR(50),
  payment_method VARCHAR(50),
  create_time TIMESTAMP,
  update_time TIMESTAMP,
  buyer_username VARCHAR(255),
  recipient_address JSONB,
  note TEXT,
  raw_data JSONB,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(order_sn)
);

-- 주문 아이템 테이블
CREATE TABLE IF NOT EXISTS order_items (
  id SERIAL PRIMARY KEY,
  order_id INTEGER NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  item_id BIGINT NOT NULL,
  item_name VARCHAR(255) NOT NULL,
  model_id BIGINT,
  model_name VARCHAR(255),
  quantity INTEGER NOT NULL DEFAULT 1,
  price NUMERIC(12, 2) DEFAULT 0,
  variation_sku VARCHAR(100),
  raw_data JSONB,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(order_id, item_id, model_id)
);

-- 주문 상태 로그
CREATE TABLE IF NOT EXISTS order_status_logs (
  id SERIAL PRIMARY KEY,
  order_id INTEGER NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  order_sn VARCHAR(32) NOT NULL,
  status VARCHAR(32) NOT NULL,
  created_at TIMESTAMP NOT NULL,
  reason VARCHAR(255)
);

-- 상품 정보 테이블
CREATE TABLE IF NOT EXISTS products (
  id SERIAL PRIMARY KEY,
  shop_id INTEGER NOT NULL REFERENCES shops(id),
  item_id BIGINT NOT NULL,
  name VARCHAR(255) NOT NULL,
  description TEXT,
  is_active BOOLEAN DEFAULT TRUE,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  raw_data JSONB,
  UNIQUE(shop_id, item_id)
);

-- 상품 변형 테이블
CREATE TABLE IF NOT EXISTS product_variations (
  id SERIAL PRIMARY KEY,
  product_id INTEGER NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  model_id BIGINT NOT NULL,
  name VARCHAR(255) NOT NULL,
  sku VARCHAR(100),
  stock INTEGER DEFAULT 0,
  price NUMERIC(12, 2) DEFAULT 0,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(product_id, model_id)
);

-- 재고 변경 로그
CREATE TABLE IF NOT EXISTS stock_logs (
  id SERIAL PRIMARY KEY,
  product_id INTEGER NOT NULL REFERENCES products(id),
  variation_id INTEGER REFERENCES product_variations(id),
  order_id INTEGER REFERENCES orders(id),
  previous_stock INTEGER NOT NULL,
  new_stock INTEGER NOT NULL,
  change_amount INTEGER NOT NULL,
  reason VARCHAR(255),
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- 인덱스 생성
CREATE INDEX IF NOT EXISTS idx_orders_shop_id ON orders(shop_id);
CREATE INDEX IF NOT EXISTS idx_orders_status ON orders(order_status);
CREATE INDEX IF NOT EXISTS idx_orders_create_time ON orders(create_time);
CREATE INDEX IF NOT EXISTS idx_order_items_order_id ON order_items(order_id);
CREATE INDEX IF NOT EXISTS idx_order_status_logs_order_id ON order_status_logs(order_id);
CREATE INDEX IF NOT EXISTS idx_products_shop_id ON products(shop_id);
CREATE INDEX IF NOT EXISTS idx_product_variations_product_id ON product_variations(product_id);
CREATE INDEX IF NOT EXISTS idx_stock_logs_product_id ON stock_logs(product_id);
CREATE INDEX IF NOT EXISTS idx_stock_logs_order_id ON stock_logs(order_id); 