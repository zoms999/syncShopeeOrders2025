const db = require('./db/db');

async function checkOrders() {
  try {
    // DB 연결 상태 확인
    console.log('데이터베이스 연결 확인 중...');
    
    // 주문 수 확인
    const orders = await db.any('SELECT COUNT(*) as count FROM public.toms_shopee_order');
    console.log('주문 수:', orders[0].count);
    
    // 주문 아이템 수 확인
    const items = await db.any('SELECT COUNT(*) as count FROM public.toms_shopee_order_item');
    console.log('주문 아이템 수:', items[0].count);
    
    // 가장 최근 주문 확인
    const recentOrders = await db.any(`
      SELECT order_num, status, created_at, updated_at 
      FROM public.toms_shopee_order 
      ORDER BY created_at DESC 
      LIMIT 5
    `);
    
    console.log('\n최근 주문 목록:');
    recentOrders.forEach(order => {
      console.log(`- 주문번호: ${order.order_num}, 상태: ${order.status}, 생성: ${order.created_at}`);
    });
    
    // 최근 주문 아이템 확인
    if (recentOrders.length > 0) {
      const recentOrderItems = await db.any(`
        SELECT i.name, i.variation_sku, i.price, i.qty, i.created_at
        FROM public.toms_shopee_order_item i
        JOIN public.toms_shopee_order o ON i.toms_order_id = o.id
        WHERE o.order_num = $1
        LIMIT 10
      `, [recentOrders[0].order_num]);
      
      console.log(`\n주문번호 ${recentOrders[0].order_num}의 아이템 목록:`);
      recentOrderItems.forEach(item => {
        console.log(`- 상품명: ${item.name}, SKU: ${item.variation_sku}, 가격: ${item.price}, 수량: ${item.qty}`);
      });
    }
  } catch (error) {
    console.error('데이터베이스 조회 오류:', error);
  } finally {
    process.exit(0);
  }
}

checkOrders(); 