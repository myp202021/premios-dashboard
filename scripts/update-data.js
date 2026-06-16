const fs = require('fs');

const WC_CK = process.env.WC_CONSUMER_KEY || 'ck_45f622f52f0946c84911d9eeba7118f815ca65b2';
const WC_CS = process.env.WC_CONSUMER_SECRET || 'cs_a064f21d2cbc373798abafccdb1cc47aabd8c697';
const REPORTEI_TOKEN = process.env.REPORTEI_TOKEN || 'tQ6y526WgRvG75NzB1CiT5RoUx9dctNmBzex5NH3';
const FB_INT_ID = 3606802;

// Products
const SORTEOS = [
  { id: 56683, name: 'Sorteo 3 — Abril 2026', start: '2026-02-16', end: '2026-04-13' },
  { id: 78432, name: 'Sorteo 4 — Mayo 2026', start: '2026-04-12', end: '2026-05-27' },
  { id: 93696, name: 'Sorteo 5 — Julio 2026', start: '2026-05-24', end: null, active: true },
];

async function wcFetch(url) {
  const sep = url.includes('?') ? '&' : '?';
  const fullUrl = `${url}${sep}consumer_key=${WC_CK}&consumer_secret=${WC_CS}`;
  const res = await fetch(fullUrl);
  return { data: await res.json(), total: parseInt(res.headers.get('X-WP-Total') || '0') };
}

async function getAllOrders(productId) {
  let page = 1, all = [];
  const { total } = await wcFetch(`https://premiosincreibles.cl/wp-json/wc/v3/orders?status=completed&product=${productId}&per_page=1`);
  console.log(`  Product ${productId}: ${total} orders to fetch`);

  while (all.length < total) {
    try {
      const { data } = await wcFetch(`https://premiosincreibles.cl/wp-json/wc/v3/orders?status=completed&product=${productId}&per_page=100&page=${page}&orderby=date&order=asc`);
      if (!Array.isArray(data) || data.length === 0) break;
      for (const o of data) {
        all.push({
          date: o.date_created.substring(0, 10),
          hour: parseInt(o.date_created.substring(11, 13)),
          total: parseInt(parseFloat(o.total)),
          email: o.billing?.email || '',
          source: '',
          device: '',
          payment: o.payment_method_title || '',
          stickers: 0
        });
        const last = all[all.length - 1];
        for (const m of (o.meta_data || [])) {
          if (m.key === '_wc_order_attribution_utm_source') last.source = m.value || '(direct)';
          if (m.key === '_wc_order_attribution_device_type') last.device = m.value;
        }
        for (const li of (o.line_items || [])) {
          last.variant = li.name;
          for (const m of (li.meta_data || [])) {
            if (m.key === 'stickers') last.stickers = parseInt(m.value) * li.quantity;
          }
        }
      }
      if (page % 20 === 0) console.log(`    page ${page} — ${all.length}/${total}`);
      page++;
    } catch (e) {
      console.log(`    error page ${page}: ${e.message} — retrying in 5s`);
      await new Promise(r => setTimeout(r, 5000));
    }
  }
  console.log(`  Product ${productId}: DONE ${all.length} orders`);
  return all;
}

async function getReporteiMetric(ref, metrics, type, start, end) {
  try {
    const res = await fetch('https://app.reportei.com/api/v2/metrics/get-data', {
      method: 'POST',
      headers: { 'Authorization': 'Bearer ' + REPORTEI_TOKEN, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        start, end, integration_id: FB_INT_ID,
        metrics: [{ id: 'q1', reference_key: ref, component: 'number_v1', metrics: metrics, type: type }]
      })
    });
    const d = await res.json();
    return parseFloat(d?.data?.q1?.values || 0);
  } catch { return 0; }
}

function analyzeSorteo(orders, name) {
  const days = [...new Set(orders.map(o => o.date))].sort();
  const emails = {};
  const sources = {};
  const weeklyData = {};
  const dailyData = {};
  const hourData = {};
  const dowData = {};
  const payments = {};
  const variants = {};
  let totalRev = 0, totalStickers = 0;

  const dowNames = ['Dom','Lun','Mar','Mié','Jue','Vie','Sáb'];

  for (const o of orders) {
    totalRev += o.total;
    totalStickers += o.stickers;
    const dayIdx = days.indexOf(o.date);
    const week = Math.floor(dayIdx / 7) + 1;

    // Daily
    dailyData[o.date] = dailyData[o.date] || { orders: 0, rev: 0, stickers: 0 };
    dailyData[o.date].orders++;
    dailyData[o.date].rev += o.total;
    dailyData[o.date].stickers += o.stickers;

    // Weekly
    weeklyData[week] = weeklyData[week] || { orders: 0, rev: 0, new: 0, repeat: 0 };
    weeklyData[week].orders++;
    weeklyData[week].rev += o.total;

    // Buyer tracking
    if (o.email) {
      if (!emails[o.email]) {
        emails[o.email] = { orders: 0, spend: 0 };
        weeklyData[week].new++;
      } else {
        weeklyData[week].repeat++;
      }
      emails[o.email].orders++;
      emails[o.email].spend += o.total;
    }

    // Source
    const src = o.source || '(direct)';
    sources[src] = (sources[src] || 0) + 1;

    // Hour
    hourData[o.hour] = (hourData[o.hour] || 0) + 1;

    // Day of week
    const dow = dowNames[new Date(o.date).getDay()];
    dowData[dow] = (dowData[dow] || 0) + 1;

    // Payment
    const pm = o.payment || 'Otro';
    payments[pm] = (payments[pm] || 0) + 1;

    // Variant
    if (o.variant) variants[o.variant] = (variants[o.variant] || 0) + 1;

    // Device (only if exists)
  }

  const uniqueBuyers = Object.keys(emails).length;
  const repeatBuyers = Object.values(emails).filter(v => v.orders > 1).length;
  const superRepeat = Object.values(emails).filter(v => v.orders >= 5).length;

  // Cumulative by week
  let cumOrders = 0;
  const weekSummary = {};
  for (const w of Object.keys(weeklyData).sort((a, b) => a - b)) {
    cumOrders += weeklyData[w].orders;
    weekSummary[w] = { ...weeklyData[w], cumulative: cumOrders };
  }

  // Group sources
  const groupedSources = {
    '(direct)': (sources['(direct)'] || 0),
    'Instagram': (sources['ig'] || 0) + (sources['l.instagram.com'] || 0),
    'Facebook': (sources['fb'] || 0) + (sources['m.facebook.com'] || 0) + (sources['l.facebook.com'] || 0) + (sources['facebook.com'] || 0) + (sources['lm.facebook.com'] || 0),
    'Google': (sources['google'] || 0) + (sources['com.google.android.googlequicksearchbox'] || 0) + (sources['com.google.android.gm'] || 0),
    'Otros': 0
  };
  const accounted = Object.values(groupedSources).reduce((s, v) => s + v, 0);
  groupedSources['Otros'] = orders.length - accounted;

  return {
    name,
    total_orders: orders.length,
    total_revenue: totalRev,
    total_stickers: totalStickers,
    days: days.length,
    first_date: days[0],
    last_date: days[days.length - 1],
    avg_ticket: Math.round(totalRev / Math.max(orders.length, 1)),
    unique_buyers: uniqueBuyers,
    repeat_buyers: repeatBuyers,
    repeat_pct: Math.round(repeatBuyers / Math.max(uniqueBuyers, 1) * 100),
    super_repeat: superRepeat,
    purchases_per_person: +(orders.length / Math.max(uniqueBuyers, 1)).toFixed(1),
    by_week: weekSummary,
    by_day: dailyData,
    by_hour: hourData,
    by_dow: dowData,
    sources: groupedSources,
    payments,
    variants,
    emails_set: new Set(Object.keys(emails))
  };
}

(async () => {
  console.log('=== Premios Increíbles Data Update ===');
  console.log('Started:', new Date().toISOString());

  // Download orders — S3/S4 from cache, S5 fresh every time
  console.log('\nDownloading orders...');
  const allOrders = {};
  for (const s of SORTEOS) {
    const cacheFile = `cache-${s.id}.json`;
    if (!s.active && fs.existsSync(cacheFile)) {
      console.log(`\n${s.name}: loaded from cache (${cacheFile})`);
      allOrders[s.id] = JSON.parse(fs.readFileSync(cacheFile, 'utf8'));
    } else {
      console.log(`\n${s.name}: fetching from WooCommerce...`);
      allOrders[s.id] = await getAllOrders(s.id);
      if (!s.active) {
        fs.writeFileSync(cacheFile, JSON.stringify(allOrders[s.id]));
        console.log(`  Cached to ${cacheFile}`);
      }
    }
  }

  // Analyze each sorteo
  console.log('\nAnalyzing...');
  const analyses = {};
  for (const s of SORTEOS) {
    analyses[s.id] = analyzeSorteo(allOrders[s.id], s.name);
  }

  // Cross-buy analysis
  const e3 = analyses[56683].emails_set;
  const e4 = analyses[78432].emails_set;
  const e5 = analyses[93696].emails_set;
  const allBuyers = new Set([...e3, ...e4, ...e5]);
  const dormant = new Set([...allBuyers].filter(e => !e5.has(e)));

  // New vs returning revenue for S5
  let newRev = 0, retRev = 0, newCount = 0, retCount = 0;
  for (const o of allOrders[93696]) {
    if (o.email && !e3.has(o.email) && !e4.has(o.email)) {
      newRev += o.total; newCount++;
    } else if (o.email) {
      retRev += o.total; retCount++;
    }
  }

  const retention = {
    s3_to_s4: { count: [...e3].filter(e => e4.has(e)).length, pct: Math.round([...e3].filter(e => e4.has(e)).length / Math.max(e4.size, 1) * 100) },
    s4_to_s5: { count: [...e4].filter(e => e5.has(e)).length, pct: Math.round([...e4].filter(e => e5.has(e)).length / Math.max(e5.size, 1) * 100) },
    all_three: [...e3].filter(e => e4.has(e) && e5.has(e)).length,
    dormant: dormant.size,
    total_pool: allBuyers.size,
    s5_new_buyers: [...e5].filter(e => !e3.has(e) && !e4.has(e)).length,
    s5_new_rev: newRev,
    s5_ret_rev: retRev,
    s5_new_ticket: newCount > 0 ? Math.round(newRev / newCount) : 0,
    s5_ret_ticket: retCount > 0 ? Math.round(retRev / retCount) : 0
  };

  // Reportei: Facebook Ads by sorteo period
  console.log('\nFetching Reportei...');
  const fbData = {};
  for (const s of SORTEOS) {
    const end = s.end || new Date().toISOString().substring(0, 10);
    const [spend, reach, impr, cpc, ctr] = await Promise.all([
      getReporteiMetric('facebook_ads:spend', ['spend'], ['spend'], s.start, end),
      getReporteiMetric('facebook_ads:reach', ['reach'], [], s.start, end),
      getReporteiMetric('facebook_ads:impressions', ['impressions'], ['impressions'], s.start, end),
      getReporteiMetric('facebook_ads:cpc', ['cpc'], [], s.start, end),
      getReporteiMetric('facebook_ads:ctr', ['ctr'], [], s.start, end)
    ]);
    fbData[s.id] = { spend, reach: Math.round(reach), impressions: Math.round(impr), cpc: +cpc.toFixed(2), ctr: +ctr.toFixed(2) };
    const a = analyses[s.id];
    fbData[s.id].inv_per_day = Math.round(spend / Math.max(a.days, 1));
    fbData[s.id].roas = spend > 0 ? +(a.total_revenue / spend).toFixed(1) : 0;
    fbData[s.id].cpa_per_order = a.total_orders > 0 ? Math.round(spend / a.total_orders) : 0;
    console.log(`  ${s.name}: $${Math.round(spend).toLocaleString()} spend, ROAS ${fbData[s.id].roas}x`);
  }

  // Build final JSON (remove email sets - not serializable)
  for (const id of Object.keys(analyses)) {
    delete analyses[id].emails_set;
  }

  const output = {
    updated: new Date().toISOString(),
    sorteos: {
      s3: { ...analyses[56683], fb: fbData[56683], product_id: 56683 },
      s4: { ...analyses[78432], fb: fbData[78432], product_id: 78432 },
      s5: { ...analyses[93696], fb: fbData[93696], product_id: 93696, active: true }
    },
    retention,
    meta: {
      total_orders_analyzed: Object.values(allOrders).reduce((s, o) => s + o.length, 0),
      total_buyers: allBuyers.size
    }
  };

  fs.writeFileSync('data.json', JSON.stringify(output));
  console.log('\ndata.json written:', Math.round(fs.statSync('data.json').size / 1024) + 'KB');
  console.log('Done:', new Date().toISOString());
})();
