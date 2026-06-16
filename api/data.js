export default async function handler(req, res) {
  const WC_CK = 'ck_45f622f52f0946c84911d9eeba7118f815ca65b2';
  const WC_CS = 'cs_a064f21d2cbc373798abafccdb1cc47aabd8c697';
  const REPORTEI_TOKEN = 'tQ6y526WgRvG75NzB1CiT5RoUx9dctNmBzex5NH3';
  const FB_INT_ID = 3606802;
  const WC_BASE = 'https://premiosincreibles.cl/wp-json/wc/v3';

  function wcUrl(path) {
    const sep = path.includes('?') ? '&' : '?';
    return `${WC_BASE}${path}${sep}consumer_key=${WC_CK}&consumer_secret=${WC_CS}`;
  }

  try {
    // WooCommerce: count orders per sorteo
    const [s4Header, s5Header] = await Promise.all([
      fetch(wcUrl('/orders?status=completed&product=78432&per_page=1')),
      fetch(wcUrl('/orders?status=completed&product=93696&per_page=1'))
    ]);
    const s4Total = parseInt(s4Header.headers.get('X-WP-Total') || '0');
    const s5Total = parseInt(s5Header.headers.get('X-WP-Total') || '0');

    // WooCommerce: last 100 orders sorteo 5 for breakdown
    const s5Res = await fetch(wcUrl('/orders?status=completed&product=93696&per_page=100&orderby=date&order=desc'));
    const s5Orders = await s5Res.json();

    let s5Rev = 0, s5Stickers = 0, s5ByVariant = {}, s5BySource = {}, s5ByDay = {};
    for (const o of (Array.isArray(s5Orders) ? s5Orders : [])) {
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
    async function getMetric(ref, metrics, type) {
      try {
        const r = await fetch('https://app.reportei.com/api/v2/metrics/get-data', {
          method: 'POST',
          headers: { 'Authorization': 'Bearer ' + REPORTEI_TOKEN, 'Content-Type': 'application/json' },
          body: JSON.stringify({
            start: '2026-05-01', end: new Date().toISOString().substring(0, 10),
            integration_id: FB_INT_ID,
            metrics: [{ id: 'q1', reference_key: ref, component: 'number_v1', metrics: metrics || [], type: type || [] }]
          })
        });
        const d = await r.json(); return d?.data?.q1?.values || null;
      } catch { return null; }
    }

    const [fbSpend, fbReach, fbImpr, fbCpc, fbCtr] = await Promise.all([
      getMetric('facebook_ads:spend', ['spend'], ['spend']),
      getMetric('facebook_ads:reach', ['reach'], []),
      getMetric('facebook_ads:impressions', ['impressions'], ['impressions']),
      getMetric('facebook_ads:cpc', ['cpc'], []),
      getMetric('facebook_ads:ctr', ['ctr'], [])
    ]);

    const result = {
      updated: new Date().toISOString(),
      sorteo4: { name: 'Sorteo 4 — Mayo 2026', product_id: 78432, total_orders: s4Total },
      sorteo5: {
        name: 'Sorteo 5 — Julio 2026 (activo)',
        product_id: 93696,
        total_orders: s5Total,
        sample: { revenue: s5Rev, stickers: s5Stickers, by_variant: s5ByVariant, by_source: s5BySource, by_day: s5ByDay, sample_size: (Array.isArray(s5Orders) ? s5Orders.length : 0) }
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
