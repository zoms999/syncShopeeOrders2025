-- SP: get_order_detail
-- 주문 상세 정보를 조회하는 스토어드 프로시저
-- 파라미터:
--   p_order_id: 주문 ID (UUID)
--   또는
--   p_order_num: 주문 번호 (VARCHAR)
--   p_platform: 플랫폼 (VARCHAR, 기본값: 'shopee')

CREATE OR REPLACE FUNCTION public.get_order_detail(
    p_order_id UUID DEFAULT NULL,
    p_order_num VARCHAR DEFAULT NULL,
    p_platform VARCHAR DEFAULT 'shopee'
)
RETURNS TABLE (
    order_id UUID,
    order_num VARCHAR,
    platform VARCHAR,
    status VARCHAR,
    action_status VARCHAR,
    other_status VARCHAR,
    country_code VARCHAR,
    currency VARCHAR,
    order_date TIMESTAMP,
    pay_date TIMESTAMP,
    day_to_ship TIMESTAMP,
    price FLOAT8,
    company_id UUID,
    shop_id VARCHAR,
    export_declaration_no VARCHAR,
    simple_memo VARCHAR,
    created_at TIMESTAMP,
    updated_at TIMESTAMP,
    arrange_shipment_at TIMESTAMP,
    print_at TIMESTAMP,
    cancel_by VARCHAR,
    cancel_reason VARCHAR,
    fulfillment_flag VARCHAR,
    message_to_seller VARCHAR,
    logistic_id UUID,
    logistic_name VARCHAR,
    tracking_no VARCHAR,
    estimated_shipping_fee FLOAT8,
    actual_shipping_cost FLOAT8,
    item_count INT,
    item_details JSONB
) AS $$
BEGIN
    RETURN QUERY
    WITH order_info AS (
        SELECT 
            o.id AS order_id,
            o.order_num,
            o.platform,
            o.status,
            o.action_status,
            o.other_status,
            o.country_code,
            o.currency,
            o.order_date,
            o.pay_date,
            o.day_to_ship,
            o.price,
            o.company_id,
            o.shop_id,
            o.export_declaration_no,
            o.simple_memo,
            o.created_at,
            o.updated_at,
            o.arrange_shipment_at,
            o.print_at,
            o.cancel_by,
            o.cancel_reason,
            o.fulfillment_flag,
            o.message_to_seller
        FROM 
            public.toms_shopee_order o
        WHERE 
            (p_order_id IS NOT NULL AND o.id = p_order_id)
            OR (p_order_num IS NOT NULL AND o.order_num = p_order_num AND o.platform = p_platform)
    ),
    logistic_info AS (
        SELECT 
            l.id AS logistic_id,
            l.name AS logistic_name,
            l.tracking_no,
            l.estimated_shipping_fee,
            l.actual_shipping_cost,
            l.toms_order_id
        FROM 
            public.toms_shopee_logistic l
        JOIN 
            order_info oi ON l.toms_order_id = oi.order_id
    ),
    item_info AS (
        SELECT 
            oi.toms_order_id,
            COUNT(oi.id) AS item_count,
            jsonb_agg(
                jsonb_build_object(
                    'id', oi.id,
                    'platform_item_id', oi.platform_item_id,
                    'variation_sku', oi.variation_sku,
                    'name', oi.name,
                    'option', oi.option,
                    'price', oi.price,
                    'original_price', oi.original_price,
                    'qty', oi.qty,
                    'weight', oi.weight,
                    'tracking_no', oi.tracking_no,
                    'image_url', oi.image_url
                )
            ) AS item_details
        FROM 
            public.toms_shopee_order_item oi
        JOIN 
            order_info o ON oi.toms_order_id = o.order_id
        GROUP BY 
            oi.toms_order_id
    )
    SELECT 
        o.order_id,
        o.order_num,
        o.platform,
        o.status,
        o.action_status,
        o.other_status,
        o.country_code,
        o.currency,
        o.order_date,
        o.pay_date,
        o.day_to_ship,
        o.price,
        o.company_id,
        o.shop_id,
        o.export_declaration_no,
        o.simple_memo,
        o.created_at,
        o.updated_at,
        o.arrange_shipment_at,
        o.print_at,
        o.cancel_by,
        o.cancel_reason,
        o.fulfillment_flag,
        o.message_to_seller,
        l.logistic_id,
        l.logistic_name,
        l.tracking_no,
        l.estimated_shipping_fee,
        l.actual_shipping_cost,
        COALESCE(i.item_count, 0) AS item_count,
        COALESCE(i.item_details, '[]'::jsonb) AS item_details
    FROM 
        order_info o
    LEFT JOIN 
        logistic_info l ON o.order_id = l.toms_order_id
    LEFT JOIN 
        item_info i ON o.order_id = i.toms_order_id;
END;
$$ LANGUAGE plpgsql;

-- 사용 예시:
-- SELECT * FROM public.get_order_detail(p_order_id := 'your-uuid-here');
-- SELECT * FROM public.get_order_detail(p_order_num := 'your-order-number', p_platform := 'shopee'); 