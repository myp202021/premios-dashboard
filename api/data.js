export default async function handler(req, res) {
  const WP_AUTH = Buffer.from('Adminweb_Pinc:gnPy AC74 nrTl nxdw PFIP taci').toString('base64');
  const REPORTEI_TOKEN = 'tQ6y526WgRvG75NzB1CiT5RoUx9dctNmBzex5NH3';
  const FB_INT_ID = 3606802;

  try {
    // WooCommerce: count orders per sorteo
    const [s4Header, s5Header] = await Promise.all([
      fetch('https://premiosincreibles.cl/wp-json/wc/v3/orders?status=completed&product=78432&per_page=1', { headers: { 'Authorization': 'Basic ' + WP_AUTH } }),
      fetch('https://premiosincreibles.cl/wp-json/wc/v3/orders?status=completed&product=93696&per_page=1', { headers: { 'Authorization': 'Basic ' + WP_AUTH } })
    ]);
    const s4Total = parseInt(s4Header.headers.get('X-WP-Total') || '0');
    const s5Total = parseInt(s5Header.headers.get('X-WP-Total') || '0');

    // WooCommerce: last 100 orders sorteo 5 for breakdown
    const s5Res = await fetch('https://premiosincreibles.cl/wp-json/wc/v3/orders?status=completed&product=93696&per_page=100&orderby=date&order=desc', {
      headers: { 'Authorization': 'Basic ' + WP_AUTH }
    });
    const s5Orders = await s5Res.json();

    let s5Rev = 0, s5Stickers = 0, s5ByVariant = {}, s5BySource = {}, s5ByDay = {};
    for (const o of s5Orders) {
      s5Rev += parseInt(parseFloat(o.total));
      const day = o.date_created.substring(0, 10);
      s5ByDay[day] = (s5ByDay[day] || 0) + 1;
      for (const li of (o.line_items || [])) {
        const name = li.name;
        s5ByVariant[name] = (s5ByVariant[name] || 0) + li.quantity;
        for (const m of (li.meta_data || [])) {
          if (m.key === 'stickers') s5Stickers += parseInt(m.value) * li.quantity;
        }
      }
      for (const m of (o.meta_data || [])) {
        if (m.key === '_wc_order_attribution_utm_source') {
          const src = m.value || '(direct)';
          s5BySource[src] = (s5BySource[src] || 0) + 1;
        }
      }
    }

    // Reportei: Facebook Ads metrics
    const sleep = ms => new Promise(r => setTimeout(r, ms));
    async function getMetric(ref, metrics, type) {
      await sleep(3200);
      const r = await fetch('https://app.reportei.com/api/v2/metrics/get-data', {
        method: 'POST',
        headers: { 'Authorization': 'Bearer ' + REPORTEI_TOKEN, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          start: '2026-05-01', end: new Date().toISOString().substring(0, 10),
          integration_id: FB_INT_ID,
          metrics: [{ id: 'q1', reference_key: ref, component: 'number_v1', metrics: metrics || [], type: type || [] }]
        })
      });
      try { const d = await r.json(); return d?.data?.q1?.values || null; } catch { return null; }
    }

    // Parallel - no rate limit delay needed for concurrent requests
    async function getMetricFast(ref, metrics, type) {
      const body = {
        start: '2026-05-01', end: new Date().toISOString().substring(0, 10),
        integration_id: FB_INT_ID,
        metrics: [{ id: 'q1', reference_key: ref, component: 'number_v1', metrics: metrics || [], type: type || [] }]
      };
      try {
        const r = await fetch('https://app.reportei.com/api/v2/metrics/get-data', {
          method: 'POST',
          headers: { 'Authorization': 'Bearer ' + REPORTEI_TOKEN, 'Content-Type': 'application/json' },
          body: JSON.stringify(body)
        });
        const d = await r.json(); return d?.data?.q1?.values || null;
      } catch { return null; }
    }

    const [fbSpend, fbReach, fbImpr, fbCpc, fbCtr] = await Promise.all([
      getMetricFast('facebook_ads:spend', ['spend'], ['spend']),
      getMetricFast('facebook_ads:reach', ['reach'], []),
      getMetricFast('facebook_ads:impressions', ['impressions'], ['impressions']),
      getMetricFast('facebook_ads:cpc', ['cpc'], []),
      getMetricFast('facebook_ads:ctr', ['ctr'], [])
    ]);

    const result = {
      updated: new Date().toISOString(),
      sorteo4: { name: 'Sorteo 4 — Mayo 2026', product_id: 78432, total_orders: s4Total, total_sales: 9615 },
      sorteo5: {
        name: 'Sorteo 5 — Julio 2026 (activo)',
        product_id: 93696,
        total_orders: s5Total,
        total_sales: 1252,
        sample: { revenue: s5Rev, stickers: s5Stickers, by_variant: s5ByVariant, by_source: s5BySource, by_day: s5ByDay, sample_size: s5Orders.length }
      },
      facebook_ads: {
        period: '1 mayo — hoy',
        spend: parseFloat(fbSpend) || 0,
        reach: parseInt(fbReach) || 0,
        impressions: parseInt(fbImpr) || 0,
        cpc: parseFloat(fbCpc) || 0,
        ctr: parseFloat(fbCtr) || 0
      }
    };

    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Cache-Control', 's-maxage=300, stale-while-revalidate=600');
    res.status(200).json(result);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
}
