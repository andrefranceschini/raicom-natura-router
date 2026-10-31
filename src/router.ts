// Order router for Natura Wellness.
// Rules 1-7 are implemented as specified. The only liberties taken are input
// normalizations (ZIP, SKU, bundles, edits); each one is recorded as a note on
// the order it changed so it shows up in the output.

export type Line = { sku: string; quantity: number };
export type Stock = { available: number; dailyVelocity: number };
export type Warehouse = {
  code: string;
  city: string;
  enabled: boolean;
  inventory: Record<string, Stock>;
};
export type Zones = Record<string, Record<string, number>>;
export type Catalog = {
  products: { sku: string }[];
  bundles: { sku: string; components: Line[] }[];
};

type RawLine = { sku: unknown; quantity: unknown };
export type RawEvent = {
  type: string;
  orderNumber: string;
  at: string;
  shipTo?: { country?: unknown; state?: unknown; zip?: unknown };
  lines?: RawLine[];
  addedLines?: RawLine[];
};

export type Order = {
  orderNumber: string;
  createdAt: number;
  country: string;
  zip: string | null;
  lines: Line[];
  notes: string[];
};

type Candidate = { code: string; zone: number; cover: number };
// How each warehouse fared for one order, so every decision can be explained without re-deriving the rules.
export type WarehouseCheck = {
  code: string;
  zone: number | null;
  result: 'chosen' | 'eligible' | 'short' | 'no zone' | 'disabled';
  cover: number | null;
  short: string[];
};
export type Movement = { sku: string; before: number; after: number };
export type Decision = {
  orderNumber: string;
  destination: string;
  decidedBy: string;
  reason: string;
  notes: string[];
  lines: Line[];
  checks: WarehouseCheck[];
  movements: Movement[];
};

// Each normalization can be switched off to see what the literal data would do.
export type Normalizations = {
  padNumericZip: boolean;
  uppercaseSku: boolean;
  expandBundles: boolean;
  applyEdits: boolean;
};
export const ALL_NORMALIZATIONS: Normalizations = {
  padNumericZip: true,
  uppercaseSku: true,
  expandBundles: true,
  applyEdits: true,
};

export const PARTNER = 'PARTNER';
export const TIE_BREAK_PRIORITY = ['WH-NJ', 'WH-GA', 'WH-NV', 'WH-TX'];
export const EDIT_WINDOW_MS = 30 * 60 * 1000;

// zones.json mixes warehouse maps with metadata keys such as "_note".
export function parseZones(raw: Record<string, unknown>): Zones {
  return Object.fromEntries(Object.entries(raw).filter(([key]) => !key.startsWith('_'))) as Zones;
}

// Returns the 5-digit ZIP, or null when it is missing or not a US ZIP.
export function normalizeZip(raw: unknown, padNumeric = true): { zip: string | null; note?: string } {
  if (typeof raw === 'number' && !padNumeric) raw = String(raw);
  if (typeof raw === 'number') {
    // A ZIP stored as a JSON number loses its leading zeros (02134 -> 2134).
    if (!Number.isInteger(raw) || raw <= 0 || raw > 99999) {
      return { zip: null, note: `ZIP ${raw} is not a valid ZIP` };
    }
    const zip = String(raw).padStart(5, '0');
    return { zip, note: zip === String(raw) ? undefined : `ZIP was the number ${raw}; read as ${zip}` };
  }
  if (typeof raw !== 'string' || raw.trim() === '') return { zip: null };
  const match = /^(\d{5})(-\d{4})?$/.exec(raw.trim());
  if (!match) return { zip: null, note: `ZIP "${raw}" is not a US ZIP` };
  return { zip: match[1], note: match[2] ? `ZIP+4 ${raw} read as ${match[1]}` : undefined };
}

// Uppercases SKUs and expands bundles into their components.
function expandLines(
  raw: RawLine[],
  catalog: Catalog,
  orderNumber: string,
  notes: string[],
  options: Normalizations,
): Line[] {
  const lines: Line[] = [];
  for (const line of raw) {
    const quantity = line.quantity;
    if (typeof quantity !== 'number' || !Number.isInteger(quantity) || quantity <= 0) {
      throw new Error(`${orderNumber}: invalid quantity ${String(quantity)}`);
    }
    const trimmed = String(line.sku).trim();
    const sku = options.uppercaseSku ? trimmed.toUpperCase() : trimmed;
    if (sku !== line.sku) notes.push(`SKU "${String(line.sku)}" read as ${sku}`);

    const bundle = options.expandBundles ? catalog.bundles.find((b) => b.sku === sku) : undefined;
    if (bundle) {
      const parts = bundle.components.map((c) => ({ sku: c.sku, quantity: c.quantity * quantity }));
      notes.push(`bundle ${sku} x${quantity} expanded to ${parts.map((p) => `${p.sku} x${p.quantity}`).join(' + ')}`);
      lines.push(...parts);
    } else {
      if (!catalog.products.some((p) => p.sku === sku)) notes.push(`unknown SKU ${sku}`);
      lines.push({ sku, quantity });
    }
  }
  return lines;
}

// Sums quantities per SKU so a bundle plus a loose unit of the same product is checked as one need.
function mergeLines(lines: Line[]): Line[] {
  const totals = new Map<string, number>();
  for (const l of lines) totals.set(l.sku, (totals.get(l.sku) ?? 0) + l.quantity);
  return [...totals].map(([sku, quantity]) => ({ sku, quantity }));
}

// Folds the event stream into one final order per order number, sorted by creation time.
export function buildOrders(
  events: RawEvent[],
  catalog: Catalog,
  options: Normalizations = ALL_NORMALIZATIONS,
): { orders: Order[]; warnings: string[] } {
  const orders = new Map<string, Order>();
  const warnings: string[] = [];

  for (const e of events) {
    if (e.type !== 'order_created') continue;
    if (orders.has(e.orderNumber)) {
      warnings.push(`duplicate order_created for ${e.orderNumber} ignored`);
      continue;
    }
    const createdAt = Date.parse(e.at);
    if (Number.isNaN(createdAt)) throw new Error(`${e.orderNumber}: invalid timestamp ${e.at}`);
    const country = String(e.shipTo?.country ?? '').trim().toUpperCase();
    const notes: string[] = [];
    const { zip, note } =
      country === 'US' ? normalizeZip(e.shipTo?.zip, options.padNumericZip) : { zip: null, note: undefined };
    if (note) notes.push(note);
    const lines = expandLines(e.lines ?? [], catalog, e.orderNumber, notes, options);
    orders.set(e.orderNumber, { orderNumber: e.orderNumber, createdAt, country, zip, lines, notes });
  }

  // Edits are applied in a second pass so an edit that arrives before its order is not lost.
  for (const e of events) {
    if (e.type === 'order_created' || (e.type === 'order_edited' && !options.applyEdits)) continue;
    if (e.type !== 'order_edited') {
      warnings.push(`unknown event type "${e.type}" for ${e.orderNumber} ignored`);
      continue;
    }
    const order = orders.get(e.orderNumber);
    if (!order) {
      warnings.push(`edit for unknown order ${e.orderNumber} ignored`);
      continue;
    }
    const delay = Date.parse(e.at) - order.createdAt;
    if (!(delay >= 0 && delay <= EDIT_WINDOW_MS)) {
      warnings.push(`edit to ${e.orderNumber} at ${e.at} is outside the 30-minute window; ignored`);
      continue;
    }
    const added = (e.addedLines ?? []).map((l) => `${String(l.sku)} x${String(l.quantity)}`).join(', ');
    order.notes.push(`edited after ${Math.round(delay / 60000)} min: added ${added}`);
    order.lines.push(...expandLines(e.addedLines ?? [], catalog, e.orderNumber, order.notes, options));
  }

  for (const order of orders.values()) order.lines = mergeLines(order.lines);
  // Array.prototype.sort is stable, so orders created at the same instant keep file order.
  const sorted = [...orders.values()].sort((a, b) => a.createdAt - b.createdAt);
  return { orders: sorted, warnings };
}

// Rule 5: smallest available / velocity across the order's products, before this order is reserved.
// A product with zero velocity never runs out, so its cover is unlimited.
export function daysOfCover(lines: Line[], inventory: Record<string, Stock>): number {
  return Math.min(
    ...lines.map((l) => {
      const s = inventory[l.sku];
      return s.dailyVelocity === 0 ? Infinity : s.available / s.dailyVelocity;
    }),
  );
}

function priorityRank(code: string): number {
  const i = TIE_BREAK_PRIORITY.indexOf(code);
  return i === -1 ? TIE_BREAK_PRIORITY.length : i;
}

// Rules 4-6. Infinity - Infinity is NaN, which is falsy, so equal unlimited cover falls through to priority.
function byRoutingRules(a: Candidate, b: Candidate): number {
  return a.zone - b.zone || b.cover - a.cover || priorityRank(a.code) - priorityRank(b.code);
}

const formatCover = (c: number) => (c === Infinity ? 'unlimited' : c.toFixed(2));

function hasStock(lines: Line[], inventory: Record<string, Stock>): boolean {
  return lines.every((l) => (inventory[l.sku]?.available ?? 0) >= l.quantity);
}

export function route(
  orders: Order[],
  warehouses: Warehouse[],
  zones: Zones,
  disabled: string[] = [],
): { decisions: Decision[]; stock: Record<string, Record<string, Stock>> } {
  const stock = structuredClone(Object.fromEntries(warehouses.map((w) => [w.code, w.inventory])));
  const open = warehouses.filter((w) => w.enabled && !disabled.includes(w.code)).map((w) => w.code);

  const decisions = orders.map((order): Decision => {
    const partner = (decidedBy: string, reason: string, checks: WarehouseCheck[] = []): Decision => ({
      orderNumber: order.orderNumber,
      destination: PARTNER,
      decidedBy,
      reason,
      notes: order.notes,
      lines: order.lines,
      checks,
      movements: [],
    });

    if (order.country !== 'US') return partner('rule 1', `rule 1: ships outside the US (${order.country || 'no country'})`);
    if (!order.zip) return partner('rule 2', 'rule 2: no usable ZIP');
    const prefix = order.zip.slice(0, 3);
    if (!Object.values(zones).some((z) => prefix in z)) {
      return partner('rule 2', `rule 2: ZIP prefix ${prefix} not in zones.json`);
    }

    const reachable = open.filter((code) => zones[code]?.[prefix] !== undefined);
    const candidates = reachable
      .filter((code) => hasStock(order.lines, stock[code]))
      .map((code) => ({ code, zone: zones[code][prefix], cover: daysOfCover(order.lines, stock[code]) }))
      .sort(byRoutingRules);

    const rank = (code: string) => {
      const i = candidates.findIndex((c) => c.code === code);
      return i === -1 ? candidates.length + priorityRank(code) : i;
    };
    const checks = warehouses
      .map((w): WarehouseCheck => {
        const zone = zones[w.code]?.[prefix] ?? null;
        const short = order.lines.filter((l) => (stock[w.code][l.sku]?.available ?? 0) < l.quantity).map((l) => l.sku);
        const candidate = candidates.find((c) => c.code === w.code);
        const result = candidate
          ? candidate === candidates[0] ? 'chosen' : 'eligible'
          : !open.includes(w.code) ? 'disabled' : zone === null ? 'no zone' : 'short';
        return { code: w.code, zone, result, cover: candidate?.cover ?? null, short };
      })
      .sort((a, b) => rank(a.code) - rank(b.code));

    if (candidates.length === 0) {
      return partner('rule 7', 'rule 7: no enabled warehouse has stock for the whole order', checks);
    }

    const [best, runnerUp] = candidates;
    const decidedBy = !runnerUp
      ? 'rule 3: only warehouse that can ship it all'
      : runnerUp.zone > best.zone
        ? 'rule 4: lowest zone'
        : runnerUp.cover !== best.cover
          ? 'rule 5: days of cover'
          : 'rule 6: priority';

    const details = checks
      .filter((c) => c.result === 'short' && c.zone !== null && c.zone < best.zone)
      .map((c) => `${c.code} zone ${c.zone} short ${c.short.join(', ')}`);
    if (runnerUp && runnerUp.zone === best.zone) {
      details.push(
        runnerUp.cover === best.cover
          ? `tied with ${runnerUp.code} on zone and cover; priority`
          : `tied with ${runnerUp.code}; cover ${formatCover(best.cover)} vs ${formatCover(runnerUp.cover)} days`,
      );
    }

    const movements = order.lines.map((l) => {
      const s = stock[best.code][l.sku];
      const before = s.available;
      s.available -= l.quantity;
      return { sku: l.sku, before, after: s.available };
    });

    return {
      orderNumber: order.orderNumber,
      destination: best.code,
      decidedBy,
      reason: `zone ${best.zone}${details.length ? ` (${details.join('; ')})` : ''}`,
      notes: order.notes,
      lines: order.lines,
      checks,
      movements,
    };
  });

  return { decisions, stock };
}

export function formatDecision(d: Decision): string {
  const notes = d.notes.length ? `  [${d.notes.join('; ')}]` : '';
  return `${d.orderNumber}  ${d.destination.padEnd(7)}  ${d.reason}${notes}`;
}
