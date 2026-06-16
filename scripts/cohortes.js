/**
 * COHORTES DE RECOMPRA — Premios Increíbles S5
 *
 * Analiza si los compradores de precio bajo ($2.500) y canal WhatsApp vuelven a comprar.
 * Llave: email (RUT no disponible en WooCommerce)
 * Identificación: por código de cupón, no por precio.
 *
 * Cohortes:
 *   A) Precio bajo: primera compra = $2.500, sin cupón WhatsApp
 *   B) Canal WhatsApp: primera compra con cupón w* (w10, w12, w13, etc.)
 *   A∩B) Las dos: primera compra = $2.500 con cupón WhatsApp
 *   C) Línea base: primera compra ≥ $5.000, sin cupón
 *
 * Output: cohortes.json
 */

const fs = require('fs');

const WC_CK = process.env.WC_CONSUMER_KEY || 'ck_45f622f52f0946c84911d9eeba7118f815ca65b2';
const WC_CS = process.env.WC_CONSUMER_SECRET || 'cs_a064f21d2cbc373798abafccdb1cc47aabd8c697';
const PRODUCT_S5 = 93696;

// Clasificación de cupones
const WA_COUPONS = new Set(['w10', 'w12', 'w13', 'w14', 'w15']); // w* = WhatsApp
const FLASH_COUPONS = new Set(['flash', 'flash4', '11junio', '9junio', 'junio2', 'junio4', 'junio5', '1junio', '3junio', 'm27', 'm29', 'm30', 'mayo30', 'super8', 'sincensura']);
// Cualquier cupón que empiece con 'w' y sea numérico después → WhatsApp
function isWaCoupon(code) { return WA_COUPONS.has(code) || /^w\d+$/.test(code); }
function isFlashCoupon(code) { return FLASH_COUPONS.has(code) || /^flash/.test(code); }
function isConcursoCoupon(code) { return isWaCoupon(code) || isFlashCoupon(code); }

async function wcFetch(url) {
  const sep = url.includes('?') ? '&' : '?';
  const fullUrl = `${url}${sep}consumer_key=${WC_CK}&consumer_secret=${WC_CS}`;
  const res = await fetch(fullUrl);
  return { data: await res.json(), total: parseInt(res.headers.get('X-WP-Total') || '0') };
}

async function getAllOrders() {
  let page = 1, all = [];
  const { total } = await wcFetch(`https://premiosincreibles.cl/wp-json/wc/v3/orders?status=completed&product=${PRODUCT_S5}&per_page=1`);
  console.log(`S5: ${total} orders to fetch`);

  while (all.length < total) {
    const { data } = await wcFetch(`https://premiosincreibles.cl/wp-json/wc/v3/orders?status=completed&product=${PRODUCT_S5}&per_page=100&page=${page}&orderby=date&order=asc`);
    if (!Array.isArray(data) || data.length === 0) break;
    for (const o of data) {
      const coupons = (o.coupon_lines || []).map(c => c.code.toLowerCase().trim());
      all.push({
        id: o.id,
        date: o.date_created.substring(0, 10),
        email: (o.billing?.email || '').toLowerCase().trim(),
        total: parseInt(parseFloat(o.total)),
        coupons,
        has_wa_coupon: coupons.some(isWaCoupon),
        has_flash_coupon: coupons.some(isFlashCoupon),
        has_concurso_coupon: coupons.some(isConcursoCoupon),
        has_any_coupon: coupons.length > 0,
        stickers: 0
      });
      const last = all[all.length - 1];
      for (const li of (o.line_items || [])) {
        for (const m of (li.meta_data || [])) {
          if (m.key === 'stickers') last.stickers += parseInt(m.value) * li.quantity;
        }
      }
    }
    page++;
    if (page % 5 === 0) process.stderr.write(`  page ${page}, ${all.length} orders...\n`);
  }
  return all;
}

function analyze(orders) {
  // Agrupar por email — ordenar por fecha
  const byEmail = {};
  orders.forEach(o => {
    if (!o.email) return;
    if (!byEmail[o.email]) byEmail[o.email] = [];
    byEmail[o.email].push(o);
  });

  // Para cada comprador: determinar cohorte por su PRIMERA compra
  const cohortes = {
    A: { name: 'Precio bajo ($2.500, sin cupón WA)', buyers: [], returners_flash: [], returners_wa: [], returners_any: [] },
    B: { name: 'Canal WhatsApp (cupón w*)', buyers: [], returners_flash: [], returners_wa: [], returners_any: [] },
    AB: { name: 'Precio bajo + WhatsApp', buyers: [], returners_flash: [], returners_wa: [], returners_any: [] },
    C: { name: 'Línea base (≥$5.000, sin cupón)', buyers: [], returners_flash: [], returners_wa: [], returners_any: [] },
    other: { name: 'Otros (con cupón no-WA en primera compra)', buyers: [], returners_flash: [], returners_wa: [], returners_any: [] }
  };

  Object.entries(byEmail).forEach(([email, purchases]) => {
    purchases.sort((a, b) => a.date.localeCompare(b.date));
    const first = purchases[0];
    const subsequent = purchases.slice(1);

    // Clasificar cohorte por primera compra
    const isPrecoBajo = first.total <= 2500;
    const isWa = first.has_wa_coupon;
    const isNoCoupon = !first.has_any_coupon;

    let cohort;
    if (isPrecoBajo && isWa) cohort = 'AB';
    else if (isPrecoBajo && !isWa) cohort = 'A';
    else if (isWa) cohort = 'B';
    else if (first.total >= 5000 && isNoCoupon) cohort = 'C';
    else cohort = 'other';

    const c = cohortes[cohort];
    c.buyers.push(email);

    // Verificar recompra con código de concurso
    const hasReturnFlash = subsequent.some(o => o.has_flash_coupon);
    const hasReturnWa = subsequent.some(o => o.has_wa_coupon);
    const hasReturnAny = subsequent.length > 0;

    if (hasReturnFlash) c.returners_flash.push(email);
    if (hasReturnWa) c.returners_wa.push(email);
    if (hasReturnAny) c.returners_any.push(email);
  });

  // Calcular métricas
  const results = {};
  Object.entries(cohortes).forEach(([key, c]) => {
    const n = c.buyers.length;
    results[key] = {
      name: c.name,
      total_buyers: n,
      returners_any: c.returners_any.length,
      returners_flash: c.returners_flash.length,
      returners_wa: c.returners_wa.length,
      return_rate_any: n > 0 ? Math.round(c.returners_any.length / n * 100) : 0,
      return_rate_flash: n > 0 ? Math.round(c.returners_flash.length / n * 100) : 0,
      return_rate_wa: n > 0 ? Math.round(c.returners_wa.length / n * 100) : 0
    };
  });

  // Tiempo promedio a segunda compra por cohorte
  Object.entries(cohortes).forEach(([key, c]) => {
    let totalDays = 0, count = 0;
    c.returners_any.forEach(email => {
      const purchases = byEmail[email];
      if (purchases.length >= 2) {
        const d1 = new Date(purchases[0].date);
        const d2 = new Date(purchases[1].date);
        const diff = Math.round((d2 - d1) / (1000 * 60 * 60 * 24));
        if (diff >= 0) { totalDays += diff; count++; }
      }
    });
    results[key].avg_days_to_return = count > 0 ? Math.round(totalDays / count) : null;
  });

  // Revenue por cohorte
  Object.entries(cohortes).forEach(([key, c]) => {
    let firstRev = 0, returnRev = 0;
    c.buyers.forEach(email => {
      const purchases = byEmail[email];
      firstRev += purchases[0].total;
      purchases.slice(1).forEach(p => returnRev += p.total);
    });
    results[key].first_purchase_rev = firstRev;
    results[key].return_rev = returnRev;
    results[key].total_rev = firstRev + returnRev;
    results[key].avg_first_ticket = c.buyers.length > 0 ? Math.round(firstRev / c.buyers.length) : 0;
    results[key].avg_return_ticket = c.returners_any.length > 0 ? Math.round(returnRev / c.returners_any.length) : 0;
  });

  return results;
}

(async () => {
  console.log('=== Cohortes de Recompra S5 ===');
  console.log('Started:', new Date().toISOString());

  const orders = await getAllOrders();
  console.log('\nTotal orders:', orders.length);
  console.log('With coupon:', orders.filter(o => o.has_any_coupon).length);
  console.log('With WA coupon:', orders.filter(o => o.has_wa_coupon).length);
  console.log('$2.500 orders:', orders.filter(o => o.total <= 2500).length);

  const results = analyze(orders);

  console.log('\n=== RESULTADOS ===\n');
  Object.entries(results).forEach(([key, r]) => {
    if (key === 'other') return;
    console.log(`${key}) ${r.name}`);
    console.log(`   Compradores: ${r.total_buyers}`);
    console.log(`   Recompra general: ${r.returners_any} (${r.return_rate_any}%)`);
    console.log(`   Recompra con flash: ${r.returners_flash} (${r.return_rate_flash}%)`);
    console.log(`   Recompra con WA: ${r.returners_wa} (${r.return_rate_wa}%)`);
    console.log(`   Días prom. a 2da compra: ${r.avg_days_to_return || '—'}`);
    console.log(`   Ticket 1ra compra: $${r.avg_first_ticket}`);
    console.log(`   Ticket recompra: $${r.avg_return_ticket || '—'}`);
    console.log(`   Revenue total: $${Math.round(r.total_rev/1000)}K`);
    console.log('');
  });

  // Guardar
  const output = {
    updated: new Date().toISOString(),
    total_orders: orders.length,
    coupon_map: {
      whatsapp: [...WA_COUPONS],
      flash: [...FLASH_COUPONS],
      note: 'Cualquier cupón w+número se clasifica como WhatsApp automáticamente'
    },
    cohortes: results
  };

  fs.writeFileSync('cohortes.json', JSON.stringify(output, null, 2));
  console.log('Saved to cohortes.json');
})().catch(e => { console.error(e); process.exit(1); });
