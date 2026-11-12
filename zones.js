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

  function build(city, opts) {
    const p = [opts.lat, opts.lng];
    const maxKm = opts.maxKm || 4, limit = opts.limit || 25;
    const prof = profile(city, p, maxKm);
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
    const inZone = hexes.filter(x => x.status === 'ok');
    const outline = inZone.length ? H3.cellsToMultiPolygon(inZone.map(x => x.h), true) : [];
    for (const ring of prof.rings) {
      ring.band = bandOf(ring.avg);
      ring.cells = inZone.filter(x => x.r === ring.r).length;
      ring.total = hexes.filter(x => x.r === ring.r).length;
    }
    const counts = {};
    for (const x of hexes) counts[x.status] = (counts[x.status] || 0) + 1;
    return { point: p, rings: prof.rings, neighborOrders: prof.neighborOrders, hexes, outline, branches, counts, maxKm, limit };
  }

  const api = { build, BANDS, bandOf, RES };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.Zones = api;
})(this);
