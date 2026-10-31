// Visual inspector for the router. It runs the same src/router.ts the CLI runs and only explains what
// the router returns, so what you see here is what routes.txt contains for the same settings.
import ordersJson from '../data/orders.json' with { type: 'json' };
import warehousesJson from '../data/warehouses.json' with { type: 'json' };
import zonesJson from '../data/zones.json' with { type: 'json' };
import catalogJson from '../data/catalog.json' with { type: 'json' };
import { ALL_NORMALIZATIONS, PARTNER, buildOrders, parseZones, route } from '../src/router.ts';
import type { Catalog, Decision, Normalizations, Order, RawEvent, Warehouse, WarehouseCheck } from '../src/router.ts';
import './style.css';

const events = ordersJson as unknown as RawEvent[];
const sourceWarehouses = warehousesJson as Warehouse[];
const zones = parseZones(zonesJson);
const catalog = catalogJson as Catalog;
const skus = catalog.products.map((p) => p.sku);
const codes = sourceWarehouses.map((w) => w.code);
// "Vitamin D, 60 softgels" -> "Vitamin D"
const names = new Map(catalogJson.products.map((p) => [p.sku, p.name.split(',')[0]]));
const productName = (sku: string) => names.get(sku) ?? sku;
const eventsByOrder = Map.groupBy(events, (e) => e.orderNumber);
const startStock = (code: string, sku: string) =>
  sourceWarehouses.find((w) => w.code === code)?.inventory[sku]?.available ?? 0;

const DATA_FIXES: Record<keyof Normalizations, { label: string; affects: string }> = {
  padNumericZip: { label: 'Restore leading zeros in numeric ZIPs', affects: '#2033: 2134 → 02134' },
  uppercaseSku: { label: 'Match SKUs regardless of case', affects: '#2045: nw-mag-90' },
  expandBundles: { label: 'Ship bundles as their components', affects: '#2040, #2056' },
  applyEdits: { label: 'Include items added by order edits', affects: '#2041' },
};

const SCENARIOS = [
  { id: 'given', label: 'Part A', detail: 'files as given', off: [] as string[] },
  { id: 'q1', label: 'Question 1', detail: 'WH-NV down', off: ['WH-NV'] },
  { id: 'q2', label: 'Q2 option 1', detail: 'WH-NV and WH-GA off', off: ['WH-NV', 'WH-GA'] },
];

const RULE_LABELS: Record<string, string> = {
  'rule 1': 'Rule 1 · outside the US',
  'rule 2': 'Rule 2 · no shipping zone',
  'rule 3: only warehouse that can ship it all': 'Rule 3 · only option',
  'rule 4: lowest zone': 'Rule 4 · lowest zone',
  'rule 5: days of cover': 'Rule 5 · days of cover',
  'rule 6: priority': 'Rule 6 · priority order',
  'rule 7': 'Rule 7 · no stock anywhere',
};
const ruleLabel = (decidedBy: string) => RULE_LABELS[decidedBy] ?? decidedBy;

type Settings = { fixes: Normalizations; enabled: Record<string, boolean> };

function scenarioSettings(id: string): Settings {
  const off = SCENARIOS.find((s) => s.id === id)!.off;
  return {
    fixes: { ...ALL_NORMALIZATIONS },
    enabled: Object.fromEntries(sourceWarehouses.map((w) => [w.code, w.enabled && !off.includes(w.code)])),
  };
}

function run(settings: Settings) {
  const { orders, warnings } = buildOrders(events, catalog, settings.fixes);
  const warehouses = sourceWarehouses.map((w) => ({ ...w, enabled: settings.enabled[w.code] }));
  return { orders, warnings, ...route(orders, warehouses, zones) };
}

// Part A as given is the reference every other scenario is compared with.
const partA = new Map(run(scenarioSettings('given')).decisions.map((d) => [d.orderNumber, d.destination]));

let settings = scenarioSettings('given');
let result = run(settings);
let selected = 0;
let focus: { code: string; sku: string } | null = null;
let changedOnly = false;
let fixesOpen = false;

const esc = (value: unknown) => String(value).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
const pill = (code: string) =>
  `<span class="pill pill-${esc(code.toLowerCase())}">${code === PARTNER ? 'Partner' : esc(code)}</span>`;
const items = (lines: { sku: string; quantity: number }[]) =>
  lines.map((l) => `${esc(productName(l.sku))} ×${l.quantity}`).join('<br>');
const formatCover = (c: number | null) => (c === null ? '—' : c === Infinity ? 'unlimited' : c.toFixed(2));
const activeScenario = () => SCENARIOS.find((s) => JSON.stringify(scenarioSettings(s.id)) === JSON.stringify(settings));
const isChanged = (d: Decision) => partA.get(d.orderNumber) !== d.destination;
const visible = () => result.decisions.map((d, i) => i).filter((i) => !changedOnly || isChanged(result.decisions[i]));
const orderOf = (n: string): Order | undefined => result.orders.find((o) => o.orderNumber === n);

// Stock after decisions[0..index] have reserved theirs (index -1 is the start of the day).
function stockAfter(index: number): Record<string, Record<string, number>> {
  const stock = Object.fromEntries(codes.map((c) => [c, Object.fromEntries(skus.map((s) => [s, startStock(c, s)]))]));
  for (const d of result.decisions.slice(0, index + 1)) {
    for (const m of d.movements) stock[d.destination][m.sku] = m.after;
  }
  return stock;
}

function renderToolbar() {
  const active = activeScenario();
  const scenarios = SCENARIOS.map(
    (s) => `<button data-scenario="${s.id}" aria-pressed="${active?.id === s.id}">
      <strong>${esc(s.label)}</strong><small>${esc(s.detail)}</small></button>`,
  ).join('');
  const warehouses = sourceWarehouses
    .map(
      (w) => `<label class="toggle" title="${esc(w.city)}${w.enabled ? '' : ' (disabled in warehouses.json)'}">
        <input type="checkbox" data-wh="${esc(w.code)}" ${settings.enabled[w.code] ? 'checked' : ''} />
        <span>${esc(w.code)}</span></label>`,
    )
    .join('');
  const fixKeys = Object.keys(DATA_FIXES) as (keyof Normalizations)[];
  const fixesOn = fixKeys.filter((k) => settings.fixes[k]).length;
  const fixes = fixKeys
    .map(
      (k) => `<label class="check"><input type="checkbox" data-fix="${k}" ${settings.fixes[k] ? 'checked' : ''} />
        <span>${esc(DATA_FIXES[k].label)} <small>${esc(DATA_FIXES[k].affects)}</small></span></label>`,
    )
    .join('');
  document.getElementById('toolbar')!.innerHTML = `
    <div class="field"><span class="field-label">Scenario</span>
      <div class="segmented" role="group" aria-label="Scenario">${scenarios}</div>
      ${active ? '' : '<span class="custom">Custom settings</span>'}</div>
    <div class="field"><span class="field-label">Warehouses</span><div class="toggles">${warehouses}</div></div>
    <details class="field fixes" ${fixesOpen ? 'open' : ''}>
      <summary><span class="field-label">Data fixes</span> ${fixesOn} of ${fixKeys.length} on</summary>
      <p class="help">Turn one off to see what reading the file literally would do, including to later orders.</p>${fixes}
    </details>`;
}

function renderSummary() {
  const counts = new Map<string, number>();
  for (const d of result.decisions) counts.set(d.destination, (counts.get(d.destination) ?? 0) + 1);
  const changed = result.decisions.filter(isChanged).length;
  const compare =
    changed === 0
      ? `<span class="muted">${activeScenario()?.id === 'given' ? 'This is the Part A result.' : 'Same routes as Part A.'}</span>`
      : `<span class="changed-note"><strong>${changed}</strong> of ${result.decisions.length} orders ship from a different place than in Part A</span>
         <label class="check inline"><input type="checkbox" data-changed-only ${changedOnly ? 'checked' : ''} /> Show only these</label>`;
  const warnings = result.warnings.length
    ? `<ul class="warnings">${result.warnings.map((w) => `<li>${esc(w)}</li>`).join('')}</ul>`
    : '';
  document.getElementById('summary')!.innerHTML = `
    <div class="counts">${[...counts].map(([code, n]) => `<span>${pill(code)} ${n}</span>`).join('')}</div>
    <div class="compare">${compare}</div>${warnings}`;
}

function renderList() {
  const showPartA = activeScenario()?.id !== 'given';
  const rows = visible()
    .map((i) => {
      const d = result.decisions[i];
      const created = eventsByOrder.get(d.orderNumber)?.find((e) => e.type === 'order_created');
      const ship = created?.shipTo;
      const zip = ship?.zip === '' || ship?.zip === undefined ? '—' : String(ship.zip);
      const where = ship?.country === 'US' ? `${esc(ship?.state ?? '')} ${esc(zip)}` : `${esc(ship?.country)}, ${esc(ship?.state ?? '')}`;
      const fixed = d.notes.length ? '<span class="tag" title="The file needed a fix for this order">data fixed</span>' : '';
      const was = partA.get(d.orderNumber)!;
      return `<tr data-index="${i}" tabindex="0" aria-selected="${i === selected}" class="${isChanged(d) ? 'changed' : ''}">
        <td><span class="mono">${esc(d.orderNumber)}</span></td>
        <td>${where}</td>
        <td>${items(d.lines)}</td>
        <td>${pill(d.destination)} ${fixed}</td>
        ${showPartA ? `<td>${isChanged(d) ? pill(was) : '<span class="muted">same</span>'}</td>` : ''}
        <td class="muted">${esc(ruleLabel(d.decidedBy))}</td>
      </tr>`;
    })
    .join('');
  document.getElementById('orders')!.innerHTML = `
    <thead><tr><th>Order</th><th>Ship to</th><th>Items</th><th>Ships from</th>${showPartA ? '<th>In Part A</th>' : ''}<th>Decided by</th></tr></thead>
    <tbody>${rows || '<tr><td colspan="6" class="muted">No orders change in this scenario.</td></tr>'}</tbody>`;
}

function shortText(c: WarehouseCheck, d: Decision, before: Record<string, Record<string, number>>): string {
  return c.short
    .map((sku) => {
      const need = d.lines.find((l) => l.sku === sku)!.quantity;
      return `needs ${need} ${esc(productName(sku))}, has ${before[c.code]?.[sku] ?? 0}`;
    })
    .join('; ');
}

// Plain-language reading of the router's own checks; no routing rule is re-evaluated here.
function explain(d: Decision, before: Record<string, Record<string, number>>): string[] {
  const order = orderOf(d.orderNumber);
  if (d.decidedBy === 'rule 1') return [`It ships to ${esc(order?.country || 'an unknown country')}, outside the US, so the partner warehouse takes it.`];
  if (d.decidedBy === 'rule 2') {
    return [
      order?.zip
        ? `No warehouse has a shipping zone for ZIP prefix ${esc(order.zip.slice(0, 3))}, so the partner warehouse takes it.`
        : 'The order has no usable ZIP, so the partner warehouse takes it.',
    ];
  }
  const chosen = d.checks.find((c) => c.result === 'chosen');
  const runnerUp = d.checks.find((c) => c.result === 'eligible');
  const closer = d.checks.filter(
    (c) => (c.result === 'short' || c.result === 'disabled') && c.zone !== null && (!chosen || c.zone < chosen.zone!),
  );
  const out = closer.map((c) =>
    c.result === 'disabled'
      ? `${esc(c.code)} would be zone ${c.zone} but is disabled.`
      : `${esc(c.code)} would be zone ${c.zone} but can't ship it all: ${shortText(c, d, before)}.`,
  );
  if (!chosen) return [...out, 'No enabled warehouse has every item in stock, so the partner warehouse takes it.'];
  if (!runnerUp) out.push(`${esc(chosen.code)} is the only enabled warehouse with every item in stock.`);
  else if (d.decidedBy.startsWith('rule 4')) {
    out.push(`Of the warehouses with every item, ${esc(chosen.code)} is closest: zone ${chosen.zone}, next is ${esc(runnerUp.code)} at zone ${runnerUp.zone}.`);
  } else if (d.decidedBy.startsWith('rule 5')) {
    out.push(
      `${esc(chosen.code)} and ${esc(runnerUp.code)} are both zone ${chosen.zone}. ${esc(chosen.code)} has more days of cover (${formatCover(chosen.cover)} vs ${formatCover(runnerUp.cover)}), so it wins the tie.`,
    );
  } else {
    out.push(`${esc(chosen.code)} and ${esc(runnerUp.code)} tie on zone and days of cover; ${esc(chosen.code)} comes first in the priority order NJ, GA, NV, TX.`);
  }
  return out;
}

function renderChecks(d: Decision, before: Record<string, Record<string, number>>): string {
  if (d.checks.length === 0) return '';
  let option = 0;
  const rows = d.checks
    .map((c) => {
      const inPlay = c.result === 'chosen' || c.result === 'eligible';
      if (inPlay) option++;
      const hasAll = c.result === 'disabled' || c.result === 'no zone' ? '—' : c.result === 'short' ? `<span class="no">✗ ${shortText(c, d, before)}</span>` : '<span class="yes">✓</span>';
      const outcome = { chosen: '<strong>Selected</strong>', eligible: `Option ${option}`, short: 'Not enough stock', 'no zone': 'No zone', disabled: 'Disabled' }[c.result];
      return `<tr class="${c.result === 'chosen' ? 'chosen' : ''}"><td>${pill(c.code)}</td><td>${c.zone ?? '—'}</td>
        <td>${hasAll}</td><td>${formatCover(c.cover)}</td><td>${outcome}</td></tr>`;
    })
    .join('');
  return `<table class="grid"><thead><tr><th>Warehouse</th><th>Zone</th><th>Has every item</th><th>Days of cover</th><th>Result</th></tr></thead>
    <tbody>${rows}</tbody></table>
    <p class="help">Rule 3 keeps enabled warehouses with every item; rule 4 picks the lowest zone; rules 5 and 6 break ties. Cover is measured before this order reserves stock.</p>`;
}

function renderInventory(d: Decision, before: Record<string, Record<string, number>>): string {
  const after = stockAfter(selected);
  const needs = new Map(d.lines.map((l) => [l.sku, l.quantity]));
  const rowsSkus = [...skus, ...d.lines.map((l) => l.sku).filter((s) => !skus.includes(s))];
  const header = codes
    .map((c) => `<th>${esc(c)}${settings.enabled[c] ? '' : ' <small class="muted">off</small>'}</th>`)
    .join('');
  const body = rowsSkus
    .map((sku) => {
      const cells = codes
        .map((code) => {
          const b = before[code]?.[sku] ?? 0;
          const a = after[code]?.[sku] ?? 0;
          const moved = d.destination === code && needs.has(sku);
          const short = settings.enabled[code] && needs.has(sku) && b < needs.get(sku)!;
          const isFocus = focus?.code === code && focus?.sku === sku;
          return `<td><button class="cell ${moved ? 'moved' : ''} ${short ? 'short' : ''}" data-cell="${esc(code)}|${esc(sku)}"
            aria-pressed="${isFocus}" title="History of ${esc(code)} ${esc(productName(sku))}">${moved ? `${b} → <strong>${a}</strong>` : a}</button></td>`;
        })
        .join('');
      return `<tr><th scope="row">${esc(productName(sku))}<small class="mono">${esc(sku)}</small></th>
        <td class="need">${needs.get(sku) ?? ''}</td>${cells}</tr>`;
    })
    .join('');
  return `<table class="grid stock"><thead><tr><th>Product</th><th>Ordered</th>${header}</tr></thead><tbody>${body}</tbody></table>
    <p class="legend"><span class="moved">taken by this order</span><span class="short">not enough for this order</span></p>
    ${renderHistory()}`;
}

function renderHistory(): string {
  if (!focus) return '<p class="help">Select a number to see how it changed through the day.</p>';
  const { code, sku } = focus;
  const entries = result.decisions.flatMap((d, i) =>
    d.destination === code ? d.movements.filter((m) => m.sku === sku).map((m) => ({ i, d, m })) : [],
  );
  const rows = entries
    .map(
      ({ i, d, m }) => `<li><button class="link ${i === selected ? 'current' : i > selected ? 'later' : ''}" data-goto="${i}">
        <span class="mono">${esc(d.orderNumber)}</span> took ${m.before - m.after} → ${m.after} left</button></li>`,
    )
    .join('');
  return `<div class="history"><h4>${esc(code)} · ${esc(productName(sku))} through the day</h4>
    <ol><li class="muted">Start of day: ${startStock(code, sku)}</li>${rows || '<li class="muted">No order took any.</li>'}</ol></div>`;
}

function renderOrderData(d: Decision): string {
  const orderEvents = eventsByOrder.get(d.orderNumber) ?? [];
  const created = orderEvents.find((e) => e.type === 'order_created');
  const order = orderOf(d.orderNumber);
  const fileItems = orderEvents
    .flatMap((e) =>
      ((e.type === 'order_created' ? e.lines : e.addedLines) ?? []).map(
        (l) => `<li><span class="mono">${esc(l.sku)}</span> ×${esc(l.quantity)}${e.type === 'order_edited' ? ` <small class="muted">added by edit at ${esc(e.at.slice(11, 16))} UTC</small>` : ''}</li>`,
      ),
    )
    .join('');
  return `<dl class="facts">
      <dt>Created</dt><dd>${esc(created?.at.replace('T', ' ').slice(0, 19))} UTC</dd>
      <dt>Ship to</dt><dd>${esc(created?.shipTo?.country)} ${esc(created?.shipTo?.state ?? '')}</dd>
      <dt>ZIP in file</dt><dd class="mono">${esc(JSON.stringify(created?.shipTo?.zip))}</dd>
      <dt>ZIP used</dt><dd class="mono">${order?.zip ? esc(order.zip) : '—'}</dd>
      <dt>Items in file</dt><dd><ul class="plain">${fileItems}</ul></dd>
      <dt>Items routed</dt><dd>${items(d.lines)}</dd>
      <dt>Data fixes</dt><dd>${d.notes.length ? `<ul class="plain">${d.notes.map((n) => `<li>${esc(n)}</li>`).join('')}</ul>` : 'None'}</dd>
    </dl>
    <details><summary>Raw events from orders.json</summary><pre>${esc(JSON.stringify(orderEvents, null, 2))}</pre></details>`;
}

function renderDetail() {
  const d = result.decisions[selected];
  const before = stockAfter(selected - 1);
  const was = partA.get(d.orderNumber)!;
  const pos = visible().indexOf(selected);
  const count = visible().length;
  document.getElementById('detail')!.innerHTML = `
    <div class="detail-head">
      <div><div class="eyebrow">Order ${selected + 1} of ${result.decisions.length} in creation order</div>
        <h2>${esc(d.orderNumber)} ships from ${pill(d.destination)}</h2>
        <div class="muted">${esc(ruleLabel(d.decidedBy))}</div></div>
      <div class="pager">
        <button data-step="-1" ${pos <= 0 ? 'disabled' : ''} aria-label="Previous order">‹ Prev</button>
        <button data-step="1" ${pos === -1 || pos >= count - 1 ? 'disabled' : ''} aria-label="Next order">Next ›</button>
      </div>
    </div>
    ${isChanged(d) ? `<p class="callout">In Part A this order ships from ${pill(was)}.</p>` : ''}
    <section class="card"><h3>Why this warehouse</h3>
      <ul class="why">${explain(d, before).map((s) => `<li>${s}</li>`).join('')}</ul>${renderChecks(d, before)}</section>
    <section class="card"><h3>Inventory before → after this order</h3>${renderInventory(d, before)}</section>
    <section class="card"><h3>Order data</h3>${renderOrderData(d)}</section>`;
}

function render() {
  renderToolbar();
  renderSummary();
  renderList();
  renderDetail();
}

function select(index: number) {
  selected = Math.max(0, Math.min(result.decisions.length - 1, index));
  const d = result.decisions[selected];
  if (d.movements.length) focus = { code: d.destination, sku: d.movements[0].sku };
  renderList();
  renderDetail();
  document.querySelector<HTMLElement>(`#orders tr[data-index="${selected}"]`)?.scrollIntoView({ block: 'nearest' });
}

function step(delta: number) {
  const list = visible();
  const pos = list.indexOf(selected);
  const next = list[pos === -1 ? 0 : Math.max(0, Math.min(list.length - 1, pos + delta))];
  if (next !== undefined) select(next);
}

// Keeps the detail pane on an order the list is actually showing.
function selectVisible() {
  const list = visible();
  select(list.includes(selected) ? selected : (list[0] ?? 0));
}

function rerun() {
  result = run(settings);
  if (!result.decisions.some(isChanged)) changedOnly = false;
  render();
  selectVisible();
}

document.addEventListener('change', (event) => {
  const input = event.target as HTMLInputElement;
  if (input.dataset.fix) settings.fixes[input.dataset.fix as keyof Normalizations] = input.checked;
  else if (input.dataset.wh) settings.enabled[input.dataset.wh] = input.checked;
  else if ('changedOnly' in input.dataset) {
    changedOnly = input.checked;
    return selectVisible();
  } else return;
  rerun();
});

document.addEventListener('click', (event) => {
  const target = event.target as HTMLElement;
  const scenario = target.closest<HTMLElement>('[data-scenario]')?.dataset.scenario;
  if (scenario) {
    settings = scenarioSettings(scenario);
    return rerun();
  }
  const delta = target.closest<HTMLElement>('[data-step]')?.dataset.step;
  if (delta) return step(Number(delta));
  const cell = target.closest<HTMLElement>('[data-cell]')?.dataset.cell;
  if (cell) {
    const [code, sku] = cell.split('|');
    focus = { code, sku };
    return renderDetail();
  }
  const goto = target.closest<HTMLElement>('[data-goto]')?.dataset.goto;
  if (goto) return select(Number(goto));
  const row = target.closest<HTMLElement>('tr[data-index]');
  if (row) select(Number(row.dataset.index));
});

// <details> toggle events do not bubble, so listen during capture to remember whether "Data fixes" is open.
document.addEventListener('toggle', (event) => {
  if ((event.target as HTMLElement).classList.contains('fixes')) fixesOpen = (event.target as HTMLDetailsElement).open;
}, true);

document.addEventListener('keydown', (event) => {
  const target = event.target as HTMLElement;
  if (event.key === 'Enter' && target.matches('tr[data-index]')) return select(Number(target.dataset.index));
  if (target.matches('input, summary')) return;
  if (event.key === 'ArrowDown') step(1);
  else if (event.key === 'ArrowUp') step(-1);
  else return;
  event.preventDefault();
});

render();
select(0);
