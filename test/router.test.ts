import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ALL_NORMALIZATIONS, PARTNER, buildOrders, daysOfCover, normalizeZip, parseZones, route } from '../src/router.ts';
import type { Catalog, RawEvent, Warehouse } from '../src/router.ts';

const dataDir = join(import.meta.dirname, '..', 'data');
const load = (file: string): any => JSON.parse(readFileSync(join(dataDir, file), 'utf8'));
const rawOrders: any[] = load('orders.json');
const rawWarehouses: Warehouse[] = load('warehouses.json');
const rawZones = load('zones.json');
const catalog: Catalog = load('catalog.json');
const zones = parseZones(rawZones);

function routeWith(events: RawEvent[] = rawOrders, options = ALL_NORMALIZATIONS, disabled: string[] = []) {
  const { orders, warnings } = buildOrders(events, catalog, options);
  return { orders, warnings, ...route(orders, rawWarehouses, zones, disabled) };
}
const destinations = (decisions: { orderNumber: string; destination: string }[]) =>
  Object.fromEntries(decisions.map((d) => [d.orderNumber, d.destination]));

// Facts about the raw files that the normalizations depend on. If the data changes, these say so first.
test('source files contain the messy inputs the normalizations target', () => {
  const byNumber = (n: string) => rawOrders.find((e) => e.type === 'order_created' && e.orderNumber === n);
  assert.equal(byNumber('#2033').shipTo.zip, 2134);
  assert.equal(byNumber('#2039').shipTo.zip, '07030-1834');
  assert.equal(byNumber('#2045').lines[0].sku, 'nw-mag-90');
  assert.equal(byNumber('#2046').shipTo.zip, '');
  assert.equal(byNumber('#2040').lines[0].sku, 'NW-BNDL-ESS');
  assert.ok(!rawWarehouses.some((w) => 'NW-BNDL-ESS' in w.inventory), 'no warehouse stocks the bundle SKU');
  const edit = rawOrders.find((e) => e.type === 'order_edited');
  assert.equal(edit.orderNumber, '#2041');
  assert.equal((Date.parse(edit.at) - Date.parse(byNumber('#2041').at)) / 60000, 18);
});

test('normalizeZip', () => {
  assert.equal(normalizeZip(2134).zip, '02134');
  assert.equal(normalizeZip(2134, false).zip, null);
  assert.equal(normalizeZip('07030-1834').zip, '07030');
  assert.equal(normalizeZip(' 30303 ').zip, '30303');
  assert.equal(normalizeZip('').zip, null);
  assert.equal(normalizeZip(undefined).zip, null);
  assert.equal(normalizeZip('2134').zip, null, 'a string ZIP kept its zeros, so a 4-digit string is malformed, not padded');
  assert.equal(normalizeZip('M5V 2T6').zip, null);
});

test('buildOrders folds the edit into #2041, expands bundles and uppercases SKUs', () => {
  const { orders, warnings } = buildOrders(rawOrders, catalog);
  const get = (n: string) => orders.find((o) => o.orderNumber === n)!;
  assert.equal(orders.length, 26);
  assert.deepEqual(warnings, []);
  assert.deepEqual(get('#2041').lines, [
    { sku: 'NW-VITD-60', quantity: 1 },
    { sku: 'NW-MULTI-30', quantity: 1 },
  ]);
  assert.deepEqual(get('#2040').lines, [
    { sku: 'NW-VITD-60', quantity: 1 },
    { sku: 'NW-MAG-90', quantity: 1 },
  ]);
  assert.deepEqual(get('#2045').lines, [{ sku: 'NW-MAG-90', quantity: 1 }]);
  assert.equal(get('#2033').zip, '02134');
  for (let i = 1; i < orders.length; i++) assert.ok(orders[i - 1].createdAt <= orders[i].createdAt);
});

test('edits outside the 30-minute window, orphan edits and duplicates are reported, not applied', () => {
  const base = { type: 'order_created', orderNumber: '#1', at: '2026-10-20T13:00:00Z', shipTo: { country: 'US', zip: '07030' } };
  const events: RawEvent[] = [
    { ...base, lines: [{ sku: 'NW-VITD-60', quantity: 1 }] },
    { ...base, lines: [{ sku: 'NW-MAG-90', quantity: 9 }] },
    { type: 'order_edited', orderNumber: '#1', at: '2026-10-20T13:31:00Z', addedLines: [{ sku: 'NW-MAG-90', quantity: 1 }] },
    { type: 'order_edited', orderNumber: '#9', at: '2026-10-20T13:05:00Z', addedLines: [{ sku: 'NW-MAG-90', quantity: 1 }] },
  ];
  const { orders, warnings } = buildOrders(events, catalog);
  assert.deepEqual(orders[0].lines, [{ sku: 'NW-VITD-60', quantity: 1 }]);
  assert.equal(warnings.length, 3);
});

test('a bundle plus a loose unit of the same product is checked as one combined need', () => {
  const events: RawEvent[] = [
    {
      type: 'order_created',
      orderNumber: '#1',
      at: '2026-10-20T13:00:00Z',
      shipTo: { country: 'US', zip: '30303' },
      lines: [
        { sku: 'NW-BNDL-ESS', quantity: 2 },
        { sku: 'NW-VITD-60', quantity: 3 },
      ],
    },
  ];
  const { orders } = buildOrders(events, catalog);
  assert.deepEqual(orders[0].lines, [
    { sku: 'NW-VITD-60', quantity: 5 },
    { sku: 'NW-MAG-90', quantity: 2 },
  ]);
  // WH-GA has only 4 VITD-60, so the combined need of 5 must skip it even though it is zone 1.
  const { decisions } = route(orders, rawWarehouses, zones);
  assert.notEqual(decisions[0].destination, 'WH-GA');
});

test('days of cover treats zero velocity as unlimited', () => {
  assert.equal(daysOfCover([{ sku: 'A', quantity: 1 }], { A: { available: 5, dailyVelocity: 0 } }), Infinity);
  assert.equal(
    daysOfCover([{ sku: 'A', quantity: 1 }, { sku: 'B', quantity: 1 }], {
      A: { available: 10, dailyVelocity: 2 },
      B: { available: 3, dailyVelocity: 3 },
    }),
    1,
  );
});

// Independent reference model. It re-reads the raw files and re-derives every route with separate code
// (its own parsing, and an explicit lexicographic minimum instead of the router's comparator), then checks
// the router agrees order by order and that stock is conserved.
// True when key a sorts before key b: first differing element decides. -Infinity === -Infinity, so equal
// unlimited cover falls through to priority.
function lexLess(a: number[], b: number[]): boolean {
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return a[i] < b[i];
  return false;
}

function referenceRoute(disabled: string[]) {
  const PRIORITY = ['WH-NJ', 'WH-GA', 'WH-NV', 'WH-TX'];
  const bundles = new Map(catalog.bundles.map((b) => [b.sku, b.components]));
  const created = rawOrders.filter((e) => e.type === 'order_created');
  const need = new Map<string, Map<string, number>>();
  const add = (n: string, sku: string, qty: number) => {
    const m = need.get(n) ?? new Map<string, number>();
    const key = sku.trim().toUpperCase();
    for (const [s, q] of bundles.has(key) ? bundles.get(key)!.map((c) => [c.sku, c.quantity * qty] as const) : [[key, qty] as const]) {
      m.set(s, (m.get(s) ?? 0) + q);
    }
    need.set(n, m);
  };
  for (const e of created) for (const l of e.lines) add(e.orderNumber, l.sku, l.quantity);
  for (const e of rawOrders.filter((x) => x.type === 'order_edited')) {
    const c = created.find((x) => x.orderNumber === e.orderNumber);
    const minutes = (Date.parse(e.at) - Date.parse(c.at)) / 60000;
    if (minutes >= 0 && minutes <= 30) for (const l of e.addedLines) add(e.orderNumber, l.sku, l.quantity);
  }

  const left = new Map<string, number>();
  for (const w of rawWarehouses) for (const [sku, s] of Object.entries(w.inventory)) left.set(`${w.code}|${sku}`, s.available);
  const velocity = (code: string, sku: string) => rawWarehouses.find((w) => w.code === code)!.inventory[sku].dailyVelocity;
  const usable = rawWarehouses.filter((w) => w.enabled && !disabled.includes(w.code)).map((w) => w.code);

  const routes: Record<string, string> = {};
  for (const e of [...created].sort((a, b) => Date.parse(a.at) - Date.parse(b.at))) {
    const zipText = typeof e.shipTo.zip === 'number' ? String(e.shipTo.zip).padStart(5, '0') : String(e.shipTo.zip ?? '');
    const prefix = /^\d{5}(-\d{4})?$/.test(zipText.trim()) ? zipText.trim().slice(0, 3) : null;
    const lines = [...need.get(e.orderNumber)!];
    let best: { code: string; key: number[] } | null = null;
    if (e.shipTo.country === 'US' && prefix && Object.values(zones).some((z) => prefix in z)) {
      for (const code of usable) {
        const zone = zones[code][prefix];
        if (zone === undefined || !lines.every(([sku, q]) => (left.get(`${code}|${sku}`) ?? 0) >= q)) continue;
        const cover = Math.min(...lines.map(([sku]) => (velocity(code, sku) === 0 ? Infinity : left.get(`${code}|${sku}`)! / velocity(code, sku))));
        const key = [zone, -cover, PRIORITY.indexOf(code)];
        if (!best || lexLess(key, best.key)) best = { code, key };
      }
    }
    routes[e.orderNumber] = best ? best.code : PARTNER;
    if (best) for (const [sku, q] of lines) left.set(`${best.code}|${sku}`, left.get(`${best.code}|${sku}`)! - q);
  }
  return { routes, left };
}

for (const scenario of [
  { name: 'Part A: files as given', disabled: [] as string[] },
  { name: 'Part B: WH-NV down', disabled: ['WH-NV'] },
]) {
  test(`reference model agrees with the router on every order (${scenario.name})`, () => {
    const { decisions, stock } = routeWith(rawOrders, ALL_NORMALIZATIONS, scenario.disabled);
    const reference = referenceRoute(scenario.disabled);
    assert.deepEqual(destinations(decisions), reference.routes);
    for (const [key, available] of reference.left) {
      const [code, sku] = key.split('|');
      assert.equal(stock[code][sku].available, available, `${key} final stock`);
      assert.ok(available >= 0, `${key} went negative`);
    }
  });

  test(`stock is conserved: start - end equals what routed orders reserved (${scenario.name})`, () => {
    const { decisions, stock } = routeWith(rawOrders, ALL_NORMALIZATIONS, scenario.disabled);
    const reserved = new Map<string, number>();
    for (const d of decisions) {
      if (d.destination === PARTNER) continue;
      for (const l of d.lines) reserved.set(`${d.destination}|${l.sku}`, (reserved.get(`${d.destination}|${l.sku}`) ?? 0) + l.quantity);
      // Each movement continues from the stock the previous order left behind.
      for (const m of d.movements) assert.equal(m.before - m.after, d.lines.find((l) => l.sku === m.sku)!.quantity);
    }
    for (const w of rawWarehouses) {
      for (const [sku, s] of Object.entries(w.inventory)) {
        assert.equal(s.available - stock[w.code][sku].available, reserved.get(`${w.code}|${sku}`) ?? 0, `${w.code} ${sku}`);
      }
    }
    assert.ok(!decisions.some((d) => d.destination === 'WH-TX'), 'disabled WH-TX never receives orders');
    assert.ok(!decisions.some((d) => scenario.disabled.includes(d.destination)));
  });
}

// Each normalization changes later orders through shared stock, not just the order it touches.
test('cascade: ignoring the #2041 edit moves #2050 to WH-GA and #2056 to WH-NV', () => {
  const routes = destinations(routeWith(rawOrders, { ...ALL_NORMALIZATIONS, applyEdits: false }).decisions);
  assert.equal(routes['#2041'], 'WH-NV');
  assert.equal(routes['#2050'], 'WH-GA');
  assert.equal(routes['#2056'], 'WH-NV');
});

test('cascade: not expanding bundles sends #2040 and #2056 to PARTNER and moves #2050 to WH-GA', () => {
  const routes = destinations(routeWith(rawOrders, { ...ALL_NORMALIZATIONS, expandBundles: false }).decisions);
  assert.equal(routes['#2040'], PARTNER);
  assert.equal(routes['#2056'], PARTNER);
  assert.equal(routes['#2050'], 'WH-GA');
});

test('cascade: without #2039 taking NJ magnesium, #2040 would ship from WH-NJ', () => {
  const routes = destinations(routeWith(rawOrders.filter((e) => e.orderNumber !== '#2039')).decisions);
  assert.equal(routes['#2040'], 'WH-NJ');
});

test('literal ZIP and SKU readings only change their own order', () => {
  const given = destinations(routeWith().decisions);
  const literal = destinations(routeWith(rawOrders, { ...ALL_NORMALIZATIONS, padNumericZip: false, uppercaseSku: false }).decisions);
  const changed = Object.keys(given).filter((n) => given[n] !== literal[n]);
  assert.deepEqual(changed, ['#2033', '#2045']);
  assert.equal(literal['#2033'], PARTNER);
  assert.equal(literal['#2045'], PARTNER);
});

// The real data never reaches rule 6, so it is exercised with synthetic warehouses.
// WH-TX is listed first on purpose: priority must come from rule 6's list, not array order.
function tieScenario(velocity: number) {
  const inventory = { 'NW-VITD-60': { available: 10, dailyVelocity: velocity } };
  const warehouses: Warehouse[] = ['WH-TX', 'WH-NV', 'WH-GA'].map((code) => ({ code, city: '', enabled: true, inventory }));
  const tieZones = { 'WH-TX': { '303': 2 }, 'WH-NV': { '303': 2 }, 'WH-GA': { '303': 2 } };
  const { orders } = buildOrders(
    [{ type: 'order_created', orderNumber: '#1', at: '2026-10-20T13:00:00Z', shipTo: { country: 'US', zip: '30303' }, lines: [{ sku: 'NW-VITD-60', quantity: 1 }] }],
    catalog,
  );
  return route(orders, warehouses, tieZones).decisions[0];
}

test('rule 6: equal zone and equal cover falls back to priority NJ, GA, NV, TX', () => {
  const d = tieScenario(5);
  assert.equal(d.destination, 'WH-GA');
  assert.equal(d.decidedBy, 'rule 6: priority');
});

test('rule 6: equal unlimited cover (zero velocity) also falls back to priority', () => {
  const d = tieScenario(0);
  assert.equal(d.destination, 'WH-GA');
  assert.equal(d.decidedBy, 'rule 6: priority');
});

test('each decision names the rule that settled it', () => {
  const decidedBy = Object.fromEntries(routeWith().decisions.map((d) => [d.orderNumber, d.decidedBy]));
  assert.equal(decidedBy['#2037'], 'rule 1');
  assert.equal(decidedBy['#2042'], 'rule 2');
  assert.equal(decidedBy['#2046'], 'rule 2');
  assert.equal(decidedBy['#2031'], 'rule 4: lowest zone');
  assert.equal(decidedBy['#2034'], 'rule 5: days of cover');
  assert.equal(decidedBy['#2048'], 'rule 5: days of cover');
  assert.equal(decidedBy['#2055'], 'rule 5: days of cover');
  assert.ok(!Object.values(decidedBy).includes('rule 6: priority'), 'rule 6 never fires on this data');
});

test('warehouse checks explain every exclusion, including a rule 7 PARTNER', () => {
  const byOrder = (decisions: { orderNumber: string }[], n: string) => decisions.find((d) => d.orderNumber === n) as any;
  const partA = routeWith().decisions;
  const d2050 = byOrder(partA, '#2050');
  assert.deepEqual(
    d2050.checks.map((c: any) => [c.code, c.result, c.zone, c.short]),
    [
      ['WH-NJ', 'chosen', 5, []],
      ['WH-NV', 'eligible', 7, []],
      ['WH-GA', 'short', 1, ['NW-VITD-60']],
      ['WH-TX', 'disabled', 4, []],
    ],
  );
  const d2056 = byOrder(routeWith(rawOrders, ALL_NORMALIZATIONS, ['WH-NV']).decisions, '#2056');
  assert.equal(d2056.destination, PARTNER);
  assert.deepEqual(
    d2056.checks.map((c: any) => [c.code, c.result, c.short]),
    [
      ['WH-NJ', 'short', ['NW-MAG-90']],
      ['WH-GA', 'short', ['NW-VITD-60']],
      ['WH-NV', 'disabled', []],
      ['WH-TX', 'disabled', []],
    ],
  );
});
