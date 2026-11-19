// Расчёт зоны доставки. Работает в браузере (глобальный h3) и в node (require).
(function (root) {
  const H3 = (typeof module !== 'undefined' && module.exports) ? require('h3-js') : root.h3;
  const RES = 9, RING_KM = 0.5;

  const BANDS = [
    { max: 10, name: 'до 10 мин', color: '#0f8a5f' },
    { max: 15, name: '10–15 мин', color: '#5cc26b' },
    { max: 20, name: '15–20 мин', color: '#3b73d9' },
    { max: 25, name: '20–25 мин', color: '#e6a100' },
    { max: 30, name: '25–30 мин', color: '#e8692c' },
    { max: Infinity, name: 'больше 30 мин', color: '#cf3434' },
  ];
  const bandOf = m => BANDS.findIndex(b => m <= b.max);

  function km(a, b) { return H3.greatCircleDistance(a, b, 'km'); }

  function lineLat(line, lng) {
    if (lng <= line[0][0]) return line[0][1];
    for (let i = 0; i < line.length - 1; i++) {
      const [x1, y1] = line[i], [x2, y2] = line[i + 1];
      if (lng >= x1 && lng <= x2) return y1 + (y2 - y1) * (lng - x1) / (x2 - x1);
    }
    return line[line.length - 1][1];
  }

  // Профиль «время от расстояния» по ресторанам вокруг точки
  function profile(city, p, maxKm) {
    const cosr = Math.cos(city.lat * Math.PI / 180);
    const nb = Math.ceil(maxKm / RING_KM);
    const collect = (radius) => {
      const acc = Array.from({ length: nb }, () => [0, 0]);
      for (const [ay, ax, b] of city.areas) {
        const c = [(ay + 0.5) * 0.02, (ax + 0.5) * 0.02 / cosr];
        if (radius !== Infinity && km(p, c) > radius) continue;
        for (let i = 0; i < nb; i++) if (b[i]) { acc[i][0] += b[i][0]; acc[i][1] += b[i][1]; }
      }
      return acc;
    };
    const local = collect(3), wide = collect(6), all = collect(Infinity);
    const rings = [];
    let neighborOrders = 0;
    for (let i = 0; i < nb; i++) {
      neighborOrders += local[i][0];
      let src = 'рядом', v = local[i];
      if (v[0] < 15) { src = 'район шире'; v = wide[i]; }
      if (v[0] < 15) { src = 'весь город'; v = all[i]; }
      const avg = v[0] ? v[1] / v[0] : null;
      rings.push({ r: i, from: i * RING_KM, to: (i + 1) * RING_KM, n: v[0], avg, src });
    }
    // кольца без данных: берём предыдущее
    for (let i = 0; i < nb; i++) if (rings[i].avg == null) rings[i].avg = i ? rings[i - 1].avg : 5;
    return { rings, neighborOrders };
  }

  function cellAt(city, lat, lng) {
    const cosr = Math.cos(city.lat * Math.PI / 180);
    return [Math.floor(lat / 0.005), Math.floor(lng / (0.005 / cosr))];
  }
  function cellCenter(city, gy, gx) {
    const cosr = Math.cos(city.lat * Math.PI / 180);
    return [(gy + 0.5) * 0.005, (gx + 0.5) * 0.005 / cosr];
  }

  // Заказы рядом и поправка ко времени из-за местности
  function local(city, pt) {
    const [gy, gx] = cellAt(city, pt[0], pt[1]);
    let n = 0, sr = 0;
    for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) {
      const c = city.cells[(gy + dy) + ',' + (gx + dx)];
      if (!c) continue;
      if (km(pt, cellCenter(city, gy + dy, gx + dx)) > 0.6) continue;
      n += c[0]; sr += c[0] * c[1];
    }
    return { n, adj: n ? sr / (n + 8) : 0 };
  }

  function segX(a, b, c, d) { // пересекаются ли отрезки ab и cd (в координатах lat/lng)
    const o = (p, q, r) => Math.sign((q[1] - p[1]) * (r[0] - q[0]) - (q[0] - p[0]) * (r[1] - q[1]));
    return o(a, b, c) !== o(a, b, d) && o(c, d, a) !== o(c, d, b);
  }
  function crossesLine(p, c, pts) {
    for (let i = 0; i < pts.length - 1; i++) if (segX(p, c, pts[i], pts[i + 1])) return true;
    return false;
  }

  function build(city, opts) {
    const p = [opts.lat, opts.lng];
    const maxKm = opts.maxKm || 4, limit = opts.limit || 25;
    const prof = profile(city, p, maxKm);
    const hf = (opts.hour != null && city.hours && city.hours[opts.hour]) ? city.hours[opts.hour] : null;
    if (hf) for (const ring of prof.rings) { ring.dayAvg = ring.avg; ring.avg = ring.avg * (hf[Math.min(ring.r, hf.length - 1)] || 1); }
    const brand = (opts.brand || '').trim().toLowerCase();
    const branches = (brand
      ? city.rest.filter(r => r[0].toLowerCase().startsWith(brand) && km(p, [r[1], r[2]]) > 0.15)
      : []).concat((opts.extraBranches || []).filter(b => km(p, [b[1], b[2]]) > 0.15));
    const origin = H3.latLngToCell(p[0], p[1], RES);
    const k = Math.ceil(maxKm / 0.33) + 1;
    const hexes = [];
    for (const h of H3.gridDisk(origin, k)) {
      const c = H3.cellToLatLng(h);
      const d = km(p, c);
      if (d > maxKm) continue;
      const r = Math.min(Math.floor(d / RING_KM), prof.rings.length - 1);
      const ring = prof.rings[r];
      const loc = local(city, c);
      const est = ring.avg + loc.adj;
      let status = 'ok', why = '';
      const other = branches.find(b => km(c, [b[1], b[2]]) < d);
      if (h === origin) status = 'ok';
      else if (other) { status = 'branch'; why = 'ближе к филиалу ' + other[0]; }
      else if (city.barriers.some(b => {
        const below = c[0] < lineLat(b.line, c[1]);
        return (b.side === 'south' ? below : !below) && d > b.allow_km;
      })) { status = 'barrier'; why = city.barriers.map(b => b.note).join('; '); }
      else if ((opts.customLines || []).some(l => d > (l.allowKm || 0) && crossesLine(p, c, l.pts))) { status = 'barrier'; why = 'за стоп-линией, нарисованной вручную'; }
      else if (loc.n === 0) { status = 'empty'; why = 'заказов рядом не было'; }
      else if (est > limit) { status = 'slow'; why = 'здесь доставка дольше: ~' + Math.round(est) + ' мин'; }
      hexes.push({ h, r, d, est, status, why, nearby: loc.n });
    }
    // оставляем только часть зоны, связанную с рестораном
    const okSet = new Set(hexes.filter(x => x.status === 'ok').map(x => x.h));
    okSet.add(origin);
    const seen = new Set([origin]), stack = [origin];
    while (stack.length) {
      const h = stack.pop();
      for (const n of H3.gridDisk(h, 1)) if (okSet.has(n) && !seen.has(n)) { seen.add(n); stack.push(n); }
    }
    for (const x of hexes) if (x.status === 'ok' && !seen.has(x.h)) { x.status = 'island'; x.why = 'оторвано от основной зоны'; }
    // ручные правки поверх расчёта
    const man = opts.manual || {};
    for (const x of hexes) {
      if (man.remove && man.remove.has(x.h) && x.status === 'ok') { x.status = 'manual'; x.why = 'убрано вручную'; }
      else if (man.add && man.add.has(x.h) && x.status !== 'ok') { x.was = x.status; x.status = 'ok'; x.added = true; x.why = 'добавлено вручную'; }
    }
    const inZone = hexes.filter(x => x.status === 'ok');
    const outline = inZone.length ? H3.cellsToMultiPolygon(inZone.map(x => x.h), true) : [];
    for (const ring of prof.rings) {
      ring.band = bandOf(ring.avg);
      ring.cells = inZone.filter(x => x.r === ring.r).length;
      ring.total = hexes.filter(x => x.r === ring.r).length;
    }
    const counts = {};
    for (const x of hexes) counts[x.status] = (counts[x.status] || 0) + 1;
    return { hour: opts.hour == null ? null : opts.hour, point: p, rings: prof.rings, neighborOrders: prof.neighborOrders, hexes, outline, branches, counts, maxKm, limit };
  }

  // Среднее время по кольцам для каждого часа + размер зоны в каждый час
  function byHour(city, opts, hours) {
    const rows = [];
    for (const h of hours) {
      const z = build(city, Object.assign({}, opts, { hour: h }));
      rows.push({ hour: h, rings: z.rings.map(r => r.avg), cells: z.counts.ok || 0, orders: (city.hourOrders || {})[h] || 0 });
    }
    return rows;
  }

  // ---------- Экономика (фуд): CM2 без флэта на заказ по км пути ----------
  const DETOUR = 1.3;   // путь по дороге ≈ расстояние по прямой × 1,3
  const norm = s => (s || '').toLowerCase().replace(/[^a-zа-яё0-9]+/gi, ' ').trim();
  const isQasyq = s => norm(s).startsWith('qasyq');

  function ecoRestCoords(city) {
    if (city._ecoIdx) return city._ecoIdx;
    const byName = {};
    for (const r of city.rest) byName[norm(r[0])] = [r[1], r[2]];
    const out = [];
    for (const [name, e] of Object.entries((city.eco || {}).rest || {})) out.push({ name, e, p: byName[norm(name)] || null });
    city._ecoIdx = out;
    return out;
  }

  function aggBands(list) {
    const acc = Array.from({ length: 8 }, () => [0, 0]);
    for (const x of list) for (const [k, [n, nf]] of Object.entries(x.e.b)) { acc[k][0] += n; acc[k][1] += n * nf; }
    return acc;
  }

  // own: данные самого ресторана (если он есть в экономике); profile: соседи того же типа
  function economy(city, opts, rings) {
    if (!city.eco) return null;
    const p = [opts.lat, opts.lng];
    const idx = ecoRestCoords(city);
    const wantQ = isQasyq(opts.brand) || isQasyq(opts.restName);
    // свой ресторан: по имени из списка или по координатам (≤150 м) с тем же брендом
    let own = null;
    if (opts.restName) own = idx.find(x => norm(x.name) === norm(opts.restName)) || null;
    if (!own) own = idx.find(x => x.p && km(p, x.p) <= 0.15 && (!opts.brand || norm(x.name).startsWith(norm(opts.brand)))) || null;
    const pool = idx.filter(x => isQasyq(x.name) === wantQ && x !== own);
    let near = pool.filter(x => x.p && km(p, x.p) <= 3);
    let src = 'соседи в радиусе 3 км';
    if (near.reduce((s, x) => s + x.e.n, 0) < 200) { near = pool; src = 'весь город'; }
    const prof = aggBands(near);
    const cityBand = aggBands(pool);
    const ownB = own ? own.e.b : null;
    const out = rings.map(r => {
      const mid = (r.from + r.to) / 2, k = Math.min(7, Math.floor(mid * DETOUR));
      let v = null, from = '';
      if (ownB && ownB[k] && ownB[k][0] >= 5) { v = ownB[k][1]; from = 'свои'; }
      else if (prof[k][0] >= 10) { v = prof[k][1] / prof[k][0]; from = own ? 'соседи' : ''; }
      else if (cityBand[k][0] >= 10) { v = cityBand[k][1] / cityBand[k][0]; from = 'город'; }
      return { r: r.r, roadKm: k, margin: v, src: from };
    });
    // рекомендация: с какого кольца начинается устойчивый минус (все дальше тоже минус)
    const vals = out.map(x => x.margin);
    let cut = null;
    for (let i = 0; i < vals.length; i++) {
      if (vals[i] != null && vals[i] < 0 && vals.slice(i).every(v => v == null || v < 0)) { cut = i; break; }
    }
    let verdict;
    if (cut === 0) verdict = 'all';
    else if (cut != null) verdict = 'cut';
    else if (vals.some(v => v != null && v < 0)) verdict = 'mixed';
    else verdict = 'ok';
    return { own: own ? Object.assign({ name: own.name }, own.e) : null, rings: out, cut, verdict, src, qasyq: wantQ, period: city.eco.period };
  }

  function lossList(city, top) {
    if (!city.eco) return [];
    return ecoRestCoords(city).filter(x => x.e.loss < 0).sort((a, b) => a.e.loss - b.e.loss).slice(0, top || 10);
  }

  const api = { build, byHour, economy, lossList, BANDS, bandOf, RES, DETOUR };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.Zones = api;
})(this);
