/**
 * Comparación S5 vs S6 — día a día
 * Métricas: venta, ticket promedio, órdenes (WooCommerce) + inversión diaria (Reportei)
 *
 * S5: 24 mayo → 19 julio 2026 (product 93696)
 * S6: 19 julio → ~4 sept 2026 (product 119945)
 *
 * Uso: node scripts/comparacion-s5-s6.js
 */
const fs = require('fs');

const WC_CK = process.env.WC_CONSUMER_KEY || 'ck_45f622f52f0946c84911d9eeba7118f815ca65b2';
const WC_CS = process.env.WC_CONSUMER_SECRET || 'cs_a064f21d2cbc373798abafccdb1cc47aabd8c697';
const REPORTEI_TOKEN = process.env.REPORTEI_TOKEN || 'tQ6y526WgRvG75NzB1CiT5RoUx9dctNmBzex5NH3';
const FB_INT_ID = 3606802;

const S5 = { id: 93696, name: 'Sorteo 5', start: '2026-05-24', end: '2026-07-19' };
const S6 = { id: 119945, name: 'Sorteo 6', start: '2026-07-20', end: null };

async function wcFetch(url) {
  const sep = url.includes('?') ? '&' : '?';
  const fullUrl = `${url}${sep}consumer_key=${WC_CK}&consumer_secret=${WC_CS}`;
  const res = await fetch(fullUrl);
  return { data: await res.json(), total: parseInt(res.headers.get('X-WP-Total') || '0') };
}

async function getAllOrders(productId, label) {
  let page = 1, all = [];
  const { total } = await wcFetch(`https://premiosincreibles.cl/wp-json/wc/v3/orders?status=completed,pending,processing&product=${productId}&per_page=1`);
  console.log(`  ${label}: ${total} orders (completed+pending+processing)`);
  while (all.length < total) {
    try {
      const { data } = await wcFetch(`https://premiosincreibles.cl/wp-json/wc/v3/orders?status=completed,pending,processing&product=${productId}&per_page=100&page=${page}&orderby=date&order=asc`);
      if (!Array.isArray(data) || data.length === 0) break;
      for (const o of data) {
        all.push({
          date: o.date_created.substring(0, 10),
          total: parseInt(parseFloat(o.total)),
          email: (o.billing?.email || '').toLowerCase().trim(),
        });
      }
      page++;
    } catch (e) {
      console.log(`    error page ${page}: ${e.message} — retry`);
      await new Promise(r => setTimeout(r, 3000));
    }
  }
  return all;
}

async function getDailySpend(date) {
  try {
    await new Promise(r => setTimeout(r, 1500));
    const res = await fetch('https://app.reportei.com/api/v2/metrics/get-data', {
      method: 'POST',
      headers: { 'Authorization': 'Bearer ' + REPORTEI_TOKEN, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        start: date, end: date, integration_id: FB_INT_ID,
        metrics: [{ id: 'q1', reference_key: 'facebook_ads:spend', component: 'number_v1', metrics: ['spend'], type: ['spend'] }]
      })
    });
    const d = await res.json();
    return parseFloat(d?.data?.q1?.values || 0);
  } catch { return 0; }
}

function dateRange(start, end) {
  const dates = [];
  let d = new Date(start + 'T12:00:00');
  const last = new Date(end + 'T12:00:00');
  while (d <= last) {
    dates.push(d.toISOString().substring(0, 10));
    d.setDate(d.getDate() + 1);
  }
  return dates;
}

function getDow(dateStr) {
  const days = ['Dom','Lun','Mar','Mié','Jue','Vie','Sáb'];
  return days[new Date(dateStr + 'T12:00:00').getDay()];
}

(async () => {
  console.log('=== Comparación S5 vs S6 ===');
  console.log('Fecha:', new Date().toISOString().substring(0, 10));

  // 1. Fetch orders
  console.log('\nDescargando órdenes...');
  const cacheS5 = 'cache-93696.json';
  let ordersS5;
  if (fs.existsSync(cacheS5)) {
    console.log('  S5: desde cache');
    ordersS5 = JSON.parse(fs.readFileSync(cacheS5, 'utf8'));
  } else {
    ordersS5 = await getAllOrders(S5.id, 'S5');
    fs.writeFileSync(cacheS5, JSON.stringify(ordersS5));
  }
  const ordersS6 = await getAllOrders(S6.id, 'S6');

  // 2. Build daily data from orders
  const s5Days = dateRange(S5.start, S5.end);
  const today = new Date().toISOString().substring(0, 10);
  const s6End = S6.end || today;
  const s6Days = dateRange(S6.start, s6End);

  function buildDailyFromOrders(orders, days) {
    const daily = {};
    for (const d of days) daily[d] = { orders: 0, revenue: 0, buyers: new Set() };
    for (const o of orders) {
      if (daily[o.date]) {
        daily[o.date].orders++;
        daily[o.date].revenue += o.total;
        if (o.email) daily[o.date].buyers.add(o.email);
      }
    }
    return daily;
  }

  const s5Daily = buildDailyFromOrders(ordersS5, s5Days);
  const s6Daily = buildDailyFromOrders(ordersS6, s6Days);

  // 3. Fetch daily spend from Reportei
  console.log('\nObteniendo inversión diaria Reportei...');

  // S5 spend: cache
  const spendCacheFile = 'cache-spend-daily-s5.json';
  let s5Spend;
  if (fs.existsSync(spendCacheFile)) {
    console.log('  S5 spend: desde cache');
    s5Spend = JSON.parse(fs.readFileSync(spendCacheFile, 'utf8'));
  } else {
    s5Spend = {};
    console.log(`  S5 spend: ${s5Days.length} días por consultar...`);
    for (let i = 0; i < s5Days.length; i++) {
      const d = s5Days[i];
      s5Spend[d] = await getDailySpend(d);
      if ((i + 1) % 10 === 0) console.log(`    ${i + 1}/${s5Days.length}`);
    }
    fs.writeFileSync(spendCacheFile, JSON.stringify(s5Spend));
    console.log('  S5 spend: cacheado');
  }

  // S6 spend: always fresh
  const s6Spend = {};
  console.log(`  S6 spend: ${s6Days.length} días...`);
  for (const d of s6Days) {
    s6Spend[d] = await getDailySpend(d);
    console.log(`    ${d}: $${Math.round(s6Spend[d]).toLocaleString()}`);
  }

  // 4. Build comparison array (day 1, day 2, etc.)
  const maxDays = Math.max(s5Days.length, s6Days.length);
  const comparison = [];

  // Accumulators
  let s5CumRev = 0, s5CumOrd = 0, s5CumSpend = 0;
  let s6CumRev = 0, s6CumOrd = 0, s6CumSpend = 0;

  for (let i = 0; i < maxDays; i++) {
    const row = { day: i + 1 };

    // S5 data
    if (i < s5Days.length) {
      const d = s5Days[i];
      const dd = s5Daily[d];
      const spend = s5Spend[d] || 0;
      s5CumRev += dd.revenue;
      s5CumOrd += dd.orders;
      s5CumSpend += spend;
      row.s5 = {
        date: d,
        dow: getDow(d),
        orders: dd.orders,
        revenue: dd.revenue,
        avg_ticket: dd.orders > 0 ? Math.round(dd.revenue / dd.orders) : 0,
        spend: Math.round(spend),
        roas_day: spend > 0 ? +(dd.revenue / spend).toFixed(1) : 0,
        cum_revenue: s5CumRev,
        cum_orders: s5CumOrd,
        cum_spend: Math.round(s5CumSpend),
      };
    }

    // S6 data
    if (i < s6Days.length) {
      const d = s6Days[i];
      const dd = s6Daily[d];
      const spend = s6Spend[d] || 0;
      s6CumRev += dd.revenue;
      s6CumOrd += dd.orders;
      s6CumSpend += spend;
      row.s6 = {
        date: d,
        dow: getDow(d),
        orders: dd.orders,
        revenue: dd.revenue,
        avg_ticket: dd.orders > 0 ? Math.round(dd.revenue / dd.orders) : 0,
        spend: Math.round(spend),
        roas_day: spend > 0 ? +(dd.revenue / spend).toFixed(1) : 0,
        cum_revenue: s6CumRev,
        cum_orders: s6CumOrd,
        cum_spend: Math.round(s6CumSpend),
      };
    }

    // Delta (solo si ambos existen)
    if (row.s5 && row.s6) {
      row.delta = {
        revenue: row.s6.revenue - row.s5.revenue,
        revenue_pct: row.s5.revenue > 0 ? Math.round((row.s6.revenue - row.s5.revenue) / row.s5.revenue * 100) : 0,
        orders: row.s6.orders - row.s5.orders,
        orders_pct: row.s5.orders > 0 ? Math.round((row.s6.orders - row.s5.orders) / row.s5.orders * 100) : 0,
        ticket: row.s6.avg_ticket - row.s5.avg_ticket,
        ticket_pct: row.s5.avg_ticket > 0 ? Math.round((row.s6.avg_ticket - row.s5.avg_ticket) / row.s5.avg_ticket * 100) : 0,
        spend: row.s6.spend - row.s5.spend,
        spend_pct: row.s5.spend > 0 ? Math.round((row.s6.spend - row.s5.spend) / row.s5.spend * 100) : 0,
      };
    }

    comparison.push(row);
  }

  // 5. Summary totals (solo para los días que S6 lleva)
  const s6DayCount = s6Days.length;
  const s5Slice = comparison.slice(0, s6DayCount);

  const summary = {
    days_compared: s6DayCount,
    s5_total_days: s5Days.length,
    s6_start: S6.start,
    s5_start: S5.start,
    s5: {
      orders: s5Slice.reduce((s, r) => s + (r.s5?.orders || 0), 0),
      revenue: s5Slice.reduce((s, r) => s + (r.s5?.revenue || 0), 0),
      spend: s5Slice.reduce((s, r) => s + (r.s5?.spend || 0), 0),
    },
    s6: {
      orders: s6CumOrd,
      revenue: s6CumRev,
      spend: Math.round(s6CumSpend),
    }
  };
  summary.s5.avg_ticket = summary.s5.orders > 0 ? Math.round(summary.s5.revenue / summary.s5.orders) : 0;
  summary.s6.avg_ticket = summary.s6.orders > 0 ? Math.round(summary.s6.revenue / summary.s6.orders) : 0;
  summary.s5.roas = summary.s5.spend > 0 ? +(summary.s5.revenue / summary.s5.spend).toFixed(1) : 0;
  summary.s6.roas = summary.s6.spend > 0 ? +(summary.s6.revenue / summary.s6.spend).toFixed(1) : 0;

  // Delta summary
  summary.delta = {
    revenue_pct: summary.s5.revenue > 0 ? Math.round((summary.s6.revenue - summary.s5.revenue) / summary.s5.revenue * 100) : 0,
    orders_pct: summary.s5.orders > 0 ? Math.round((summary.s6.orders - summary.s5.orders) / summary.s5.orders * 100) : 0,
    ticket_pct: summary.s5.avg_ticket > 0 ? Math.round((summary.s6.avg_ticket - summary.s5.avg_ticket) / summary.s5.avg_ticket * 100) : 0,
    spend_pct: summary.s5.spend > 0 ? Math.round((summary.s6.spend - summary.s5.spend) / summary.s5.spend * 100) : 0,
  };

  const output = {
    updated: new Date().toISOString(),
    summary,
    comparison,
  };

  fs.writeFileSync('comparacion-s5-s6.json', JSON.stringify(output));
  console.log('\n✅ comparacion-s5-s6.json escrito');
  console.log(`   ${s6DayCount} días comparados`);
  console.log(`   S5 (${s6DayCount}d): ${summary.s5.orders} orders, $${(summary.s5.revenue/1000).toFixed(0)}K rev, $${(summary.s5.spend/1000).toFixed(0)}K spend`);
  console.log(`   S6 (${s6DayCount}d): ${summary.s6.orders} orders, $${(summary.s6.revenue/1000).toFixed(0)}K rev, $${(summary.s6.spend/1000).toFixed(0)}K spend`);
})();
