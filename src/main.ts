// CLI: prints one route per order to stdout; warnings and the stock ledger go to stderr.
// Usage: node src/main.ts [--disable WH-NV] [--trace]
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { buildOrders, formatDecision, parseZones, route } from './router.ts';
import type { Catalog, RawEvent, Warehouse } from './router.ts';

const { values } = parseArgs({
  options: {
    data: { type: 'string', default: join(import.meta.dirname, '..', 'data') },
    disable: { type: 'string', multiple: true, default: [] },
    trace: { type: 'boolean', default: false },
  },
});

const load = (file: string): unknown => JSON.parse(readFileSync(join(values.data, file), 'utf8'));
const events = load('orders.json') as RawEvent[];
const warehouses = load('warehouses.json') as Warehouse[];
const zones = parseZones(load('zones.json') as Record<string, unknown>);
const catalog = load('catalog.json') as Catalog;

const { orders, warnings } = buildOrders(events, catalog);
const { decisions, stock } = route(orders, warehouses, zones, values.disable);

for (const d of decisions) {
  console.log(formatDecision(d));
  if (values.trace) {
    for (const m of d.movements) console.error(`  ${d.orderNumber} ${d.destination} ${m.sku} ${m.before} -> ${m.after}`);
  }
}

for (const w of warnings) console.error(`warning: ${w}`);
if (values.disable.length) console.error(`disabled for this run: ${values.disable.join(', ')}`);
console.error('\nstock ledger (start -> end):');
for (const w of warehouses) {
  const cells = Object.entries(w.inventory).map(([sku, s]) => `${sku} ${s.available} -> ${stock[w.code][sku].available}`);
  console.error(`  ${w.code}${w.enabled ? '' : ' (disabled)'}: ${cells.join(', ')}`);
}
