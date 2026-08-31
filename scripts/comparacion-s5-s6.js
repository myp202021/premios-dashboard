/**
 * Comparación S5 vs S6 — INCREMENTAL
 * Lee el JSON existente y solo agrega los días nuevos.
 * Si no existe JSON previo, hace full build.
 *
 * S5: 24 mayo → 19 julio 2026 (product 93696)
 * S6: 19 julio → ~4 sept 2026 (product 119945)
 */
const fs = require('fs');

const WC_CK = process.env.WC_CONSUMER_KEY || 'ck_45f622f52f0946c84911d9eeba7118f815ca65b2';
const WC_CS = process.env.WC_CONSUMER_SECRET || 'cs_a064f21d2cbc373798abafccdb1cc47aabd8c697';
const REPORTEI_TOKEN = process.env.REPORTEI_TOKEN || 'tQ6y526WgRvG75NzB1CiT5RoUx9dctNmBzex5NH3';
const FB_INT_ID = 3606802;

const S5 = { id: 93696, name: 'Sorteo 5', start: '2026-05-24', end: '2026-07-19' };
const S6 = { id: 119945, name: 'Sorteo 6', start: '2026-07-20', end: null };

const OUTPUT_FILE = 'comparacion-s5-s6.json';

async function wcFetch(url) {
  const sep = url.includes('?') ? '&' : '?';
  const fullUrl = `${url}${sep}consumer_key=${WC_CK}&consumer_secret=${WC_CS}`;
  const res = await fetch(fullUrl);
  return { data: await res.json(), total: parseInt(res.headers.get('X-WP-Total') || '0') };
}

async function getOrdersSince(productId, sinceDate, label) {
  let page = 1, all = [];
  console.log(`  ${label}: órdenes desde ${sinceDate}...`);
  while (true) {
    try {
      const { data } = await wcFetch(
        `https://premiosincreibles.cl/wp-json/wc/v3/orders?status=completed&product=${productId}&per_page=100&page=${page}&orderby=date&order=asc&after=${sinceDate}T00:00:00`
      );
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
  console.log(`  ${label}: ${all.length} órdenes nuevas`);
  return all;
}

async function getAllOrders(productId, label) {
  let page = 1, all = [];
  const { total } = await wcFetch(`https://premiosincreibles.cl/wp-json/wc/v3/orders?status=completed&product=${productId}&per_page=1`);
  console.log(`  ${label}: ${total} orders total`);
  while (all.length < total) {
    try {
      const { data } = await wcFetch(`https://premiosincreibles.cl/wp-json/wc/v3/orders?status=completed&product=${productId}&per_page=100&page=${page}&orderby=date&order=asc`);
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
    await new Promise(r => setTimeout(r, 800));
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 10000);
    let res;
    try {
      res = await fetch('https://app.reportei.com/api/v2/metrics/get-data', {
        method: 'POST',
        headers: { 'Authorization': 'Bearer ' + REPORTEI_TOKEN, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          start: date, end: date, integration_id: FB_INT_ID,
          metrics: [{ id: 'q1', reference_key: 'facebook_ads:spend', component: 'number_v1', metrics: ['spend'], type: ['spend'] }]
        }),
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timer);
    }
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

function esOfertaLaboral(texto) {
  if (!texto) return false;
  const t = texto.toLowerCase();
  const kw = ['vacante', 'postula', 'buscamos', 'se busca', 'oferta laboral', 'únete', 'trabaja con nosotros', 'hiring', 'job opening', 'reclutamiento', 'cargo', 'conductor', 'operador'];
  return kw.some(k => t.includes(k));
}

(async () => {
  const today = new Date().toISOString().substring(0, 10);
  console.log('=== Comparación S5 vs S6 (INCREMENTAL) ===');
  console.log('Fecha:', today);

  // ─── Cargar datos existentes ───
  let existing = null;
  if (fs.existsSync(OUTPUT_FILE)) {
    existing = JSON.parse(fs.readFileSync(OUTPUT_FILE, 'utf8'));
    console.log(`\nJSON existente: ${existing.comparison.length} rows, actualizado ${existing.updated}`);
  }

  // ─── Cargar caches de órdenes ───
  const cacheS3 = 'cache-56683.json', cacheS4 = 'cache-78432.json';
  const cacheS5 = 'cache-93696.json', cacheS6 = 'cache-119945.json';

  // S3, S4, S5: siempre desde cache (sorteos cerrados)
  const ordersS3 = fs.existsSync(cacheS3) ? JSON.parse(fs.readFileSync(cacheS3, 'utf8')) : [];
  const ordersS4 = fs.existsSync(cacheS4) ? JSON.parse(fs.readFileSync(cacheS4, 'utf8')) : [];
  let ordersS5;
  if (fs.existsSync(cacheS5)) {
    ordersS5 = JSON.parse(fs.readFileSync(cacheS5, 'utf8'));
    console.log(`  S5: ${ordersS5.length} orders (cache)`);
  } else {
    ordersS5 = await getAllOrders(S5.id, 'S5');
    fs.writeFileSync(cacheS5, JSON.stringify(ordersS5));
  }

  // S6: cache incremental
  let ordersS6;
  if (fs.existsSync(cacheS6)) {
    const cached = JSON.parse(fs.readFileSync(cacheS6, 'utf8'));
    const lastDate = cached.reduce((max, o) => o.date > max ? o.date : max, '2000-01-01');
    console.log(`  S6: cache ${cached.length} orders hasta ${lastDate}`);
    const newOrders = await getOrdersSince(S6.id, lastDate, 'S6 nuevas');
    const base = cached.filter(o => o.date < lastDate);
    ordersS6 = [...base, ...newOrders];
  } else {
    ordersS6 = await getAllOrders(S6.id, 'S6');
  }
  fs.writeFileSync(cacheS6, JSON.stringify(ordersS6));
  console.log(`  S6 total: ${ordersS6.length} orders`);

  // ─── Determinar qué días calcular ───
  const s5Days = dateRange(S5.start, S5.end);
  const s6End = S6.end || today;
  const s6Days = dateRange(S6.start, s6End);

  // Si hay JSON existente, solo calcular días nuevos
  let lastExistingS6Day = null;
  if (existing && existing.comparison.length > 0) {
    const lastRow = existing.comparison[existing.comparison.length - 1];
    if (lastRow.s6) lastExistingS6Day = lastRow.s6.date;
  }

  const newS6Days = lastExistingS6Day
    ? s6Days.filter(d => d > lastExistingS6Day)
    : s6Days;

  console.log(`\n  Días S6 totales: ${s6Days.length}, nuevos a calcular: ${newS6Days.length}`);

  if (newS6Days.length === 0 && existing) {
    console.log('✅ Sin días nuevos — JSON ya está al día');
    return;
  }

  // ─── Spend: solo días nuevos + recalcular ayer ───
  const spendCacheS5File = 'cache-spend-daily-s5.json';
  const spendCacheS6File = 'cache-spend-daily-s6.json';

  let s5Spend;
  if (fs.existsSync(spendCacheS5File)) {
    s5Spend = JSON.parse(fs.readFileSync(spendCacheS5File, 'utf8'));
    console.log(`  S5 spend: cache (${Object.keys(s5Spend).length} días)`);
  } else {
    s5Spend = {};
    console.log(`  S5 spend: consultando ${s5Days.length} días...`);
    for (let i = 0; i < s5Days.length; i++) {
      s5Spend[s5Days[i]] = await getDailySpend(s5Days[i]);
      if ((i + 1) % 10 === 0) console.log(`    ${i + 1}/${s5Days.length}`);
    }
    fs.writeFileSync(spendCacheS5File, JSON.stringify(s5Spend));
  }

  let s6Spend = {};
  if (fs.existsSync(spendCacheS6File)) {
    s6Spend = JSON.parse(fs.readFileSync(spendCacheS6File, 'utf8'));
  }
  // Solo consultar días nuevos + ayer (por si se actualizó)
  const yesterday = new Date(Date.now() - 86400000).toISOString().substring(0, 10);
  const daysToFetchSpend = [...new Set([...newS6Days, yesterday])].filter(d => s6Days.includes(d));
  console.log(`  S6 spend: consultando ${daysToFetchSpend.length} días...`);
  for (const d of daysToFetchSpend) {
    s6Spend[d] = await getDailySpend(d);
    console.log(`    ${d}: $${Math.round(s6Spend[d]).toLocaleString()}`);
  }
  fs.writeFileSync(spendCacheS6File, JSON.stringify(s6Spend));

  // ─── Rebuild completo del comparison array (rápido, solo math en memoria) ───
  const allS3Emails = new Set(ordersS3.map(o => o.email).filter(Boolean));
  const allS4Emails = new Set(ordersS4.map(o => o.email).filter(Boolean));
  const allS5Emails = new Set(ordersS5.map(o => o.email).filter(Boolean));

  // Nuevos S5 = no estaban en S3/S4
  const s5OnlyEmails = new Set();
  for (const o of ordersS5) {
    if (o.email && !allS3Emails.has(o.email) && !allS4Emails.has(o.email)) {
      s5OnlyEmails.add(o.email);
    }
  }
  console.log(`  Clientes nuevos S5: ${s5OnlyEmails.size}`);

  // Daily aggregation
  function buildDaily(orders, days) {
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

  function calcNewVsRepeat(orders, days, previousEmails) {
    const seenInSorteo = new Set();
    const daily = {};
    for (const d of days) daily[d] = { new_orders: 0, new_revenue: 0, repeat_orders: 0, repeat_revenue: 0 };
    const sorted = [...orders].sort((a, b) => a.date.localeCompare(b.date));
    for (const o of sorted) {
      if (!daily[o.date]) continue;
      const isRepeat = previousEmails.has(o.email) || seenInSorteo.has(o.email);
      if (isRepeat) { daily[o.date].repeat_orders++; daily[o.date].repeat_revenue += o.total; }
      else { daily[o.date].new_orders++; daily[o.date].new_revenue += o.total; }
      if (o.email) seenInSorteo.add(o.email);
    }
    return daily;
  }

  function calcCosecha(orders, days, targetEmails) {
    const daily = {};
    for (const d of days) daily[d] = { harvest_orders: 0, harvest_revenue: 0 };
    for (const o of orders) {
      if (daily[o.date] && targetEmails.has(o.email)) {
        daily[o.date].harvest_orders++;
        daily[o.date].harvest_revenue += o.total;
      }
    }
    return daily;
  }

  const s5Daily = buildDaily(ordersS5, s5Days);
  const s6Daily = buildDaily(ordersS6, s6Days);
  const s5PreviousEmails = new Set([...allS3Emails, ...allS4Emails]);
  const s5NewRepeat = calcNewVsRepeat(ordersS5, s5Days, s5PreviousEmails);
  const s6NewRepeat = calcNewVsRepeat(ordersS6, s6Days, allS5Emails);
  const s6Cosecha = calcCosecha(ordersS6, s6Days, s5OnlyEmails);

  // Build comparison
  const maxDays = Math.max(s5Days.length, s6Days.length);
  const comparison = [];
  let s5CumRev = 0, s5CumOrd = 0, s5CumSpend = 0;
  let s6CumRev = 0, s6CumOrd = 0, s6CumSpend = 0;

  for (let i = 0; i < maxDays; i++) {
    const row = { day: i + 1 };

    if (i < s5Days.length) {
      const d = s5Days[i];
      const dd = s5Daily[d];
      const spend = s5Spend[d] || 0;
      s5CumRev += dd.revenue; s5CumOrd += dd.orders; s5CumSpend += spend;
      const nr = s5NewRepeat[d] || { new_orders:0, new_revenue:0, repeat_orders:0, repeat_revenue:0 };
      row.s5 = {
        date: d, dow: getDow(d), orders: dd.orders, revenue: dd.revenue,
        avg_ticket: dd.orders > 0 ? Math.round(dd.revenue / dd.orders) : 0,
        spend: Math.round(spend),
        roas_day: spend > 0 ? +(dd.revenue / spend).toFixed(1) : 0,
        cum_revenue: s5CumRev, cum_orders: s5CumOrd, cum_spend: Math.round(s5CumSpend),
        new_orders: nr.new_orders, new_revenue: nr.new_revenue,
        repeat_orders: nr.repeat_orders, repeat_revenue: nr.repeat_revenue,
      };
    }

    if (i < s6Days.length) {
      const d = s6Days[i];
      const dd = s6Daily[d];
      const spend = s6Spend[d] || 0;
      s6CumRev += dd.revenue; s6CumOrd += dd.orders; s6CumSpend += spend;
      const nr = s6NewRepeat[d] || { new_orders:0, new_revenue:0, repeat_orders:0, repeat_revenue:0 };
      const cos = s6Cosecha[d] || { harvest_orders:0, harvest_revenue:0 };
      row.s6 = {
        date: d, dow: getDow(d), orders: dd.orders, revenue: dd.revenue,
        avg_ticket: dd.orders > 0 ? Math.round(dd.revenue / dd.orders) : 0,
        spend: Math.round(spend),
        roas_day: spend > 0 ? +(dd.revenue / spend).toFixed(1) : 0,
        cum_revenue: s6CumRev, cum_orders: s6CumOrd, cum_spend: Math.round(s6CumSpend),
        new_orders: nr.new_orders, new_revenue: nr.new_revenue,
        repeat_orders: nr.repeat_orders, repeat_revenue: nr.repeat_revenue,
        harvest_orders: cos.harvest_orders, harvest_revenue: cos.harvest_revenue,
      };
    }

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

  // Summary
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
    s6: { orders: s6CumOrd, revenue: s6CumRev, spend: Math.round(s6CumSpend) }
  };
  summary.s5.avg_ticket = summary.s5.orders > 0 ? Math.round(summary.s5.revenue / summary.s5.orders) : 0;
  summary.s6.avg_ticket = summary.s6.orders > 0 ? Math.round(summary.s6.revenue / summary.s6.orders) : 0;
  summary.s5.roas = summary.s5.spend > 0 ? +(summary.s5.revenue / summary.s5.spend).toFixed(1) : 0;
  summary.s6.roas = summary.s6.spend > 0 ? +(summary.s6.revenue / summary.s6.spend).toFixed(1) : 0;
  summary.delta = {
    revenue_pct: summary.s5.revenue > 0 ? Math.round((summary.s6.revenue - summary.s5.revenue) / summary.s5.revenue * 100) : 0,
    orders_pct: summary.s5.orders > 0 ? Math.round((summary.s6.orders - summary.s5.orders) / summary.s5.orders * 100) : 0,
    ticket_pct: summary.s5.avg_ticket > 0 ? Math.round((summary.s6.avg_ticket - summary.s5.avg_ticket) / summary.s5.avg_ticket * 100) : 0,
    spend_pct: summary.s5.spend > 0 ? Math.round((summary.s6.spend - summary.s5.spend) / summary.s5.spend * 100) : 0,
  };
  summary.cosecha = {
    nuevos_s5_total: s5OnlyEmails.size,
    volvieron_s6: new Set(ordersS6.filter(o => s5OnlyEmails.has(o.email)).map(o => o.email)).size,
    harvest_orders: comparison.reduce((s,r) => s + (r.s6?.harvest_orders||0), 0),
    harvest_revenue: comparison.reduce((s,r) => s + (r.s6?.harvest_revenue||0), 0),
  };
  summary.cosecha.tasa_cosecha = summary.cosecha.nuevos_s5_total > 0
    ? +(summary.cosecha.volvieron_s6 / summary.cosecha.nuevos_s5_total * 100).toFixed(1) : 0;

  const output = { updated: new Date().toISOString(), summary, comparison };
  fs.writeFileSync(OUTPUT_FILE, JSON.stringify(output));

  console.log(`\n✅ ${OUTPUT_FILE} escrito`);
  console.log(`   ${s6DayCount} días comparados (${newS6Days.length} nuevos)`);
  console.log(`   S5 (${s6DayCount}d): ${summary.s5.orders} orders, $${(summary.s5.revenue/1000).toFixed(0)}K`);
  console.log(`   S6 (${s6DayCount}d): ${summary.s6.orders} orders, $${(summary.s6.revenue/1000).toFixed(0)}K`);
  console.log(`   Cosecha: ${summary.cosecha.volvieron_s6}/${summary.cosecha.nuevos_s5_total} (${summary.cosecha.tasa_cosecha}%)`);
})();
