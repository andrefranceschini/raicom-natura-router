# Natura Wellness order router

Routes every order in `data/orders.json` to one warehouse (or PARTNER) using rules 1-7 from the brief, reserving stock as it goes so later orders see what earlier ones left. Output: [`routes.txt`](routes.txt).

TypeScript, no runtime dependencies. Node 23.6+ runs the `.ts` files directly.

```bash
npm install          # dev tools only: typescript, vite, @types/node
npm run route        # writes routes.txt; warnings and the stock ledger go to stderr
npm test             # unit tests, independent reference model, cascade checks
npm run dev          # optional visual inspector (see below)
```

`node src/main.ts --trace` also prints every stock movement, order by order.

## Routing rules: implemented as written

The rules are not changed. Every decision records which rule settled it (`decidedBy`) and how each warehouse fared: its zone, cover, and whether it was chosen, eligible, short of a SKU, without a zone, or disabled.

On this data, rule 4 settles most orders, and rule 5 (cover) breaks the zone ties in #2034, #2048 and #2055 (and #2038 with WH-NV down). **Rule 6 (priority) never fires on this data**, so it's covered by synthetic tests, including the tie between two unlimited covers.

## Interpretations a reader could make differently

| Point | Reading used | Other reading | Effect on this data |
|---|---|---|---|
| "Apply the rules to the files exactly as given" | Rules unchanged, data cleaned (table below) | Don't clean the data | #2033, #2040, #2045, #2056 → PARTNER and #2041 to NV; #2050 moves too |
| When edits are applied | Folded in before routing; the order keeps its creation-time place | Route at creation, ignore late lines | #2041, #2050, #2056 change |
| Edit windows still open | `orders.json` is treated as complete | #2047–#2056 were created < 30 min before the last event, so a live router would wait | None (no later events exist) |
| Days of cover (rule 5) | Stock *before* this order is reserved; zero velocity = unlimited | Stock after reserving | None: verified identical |
| "ZIP prefix isn't in zones.json" (rule 2) | No warehouse has a zone for it | Any warehouse lacks it | None: all warehouses list the same prefixes |
| Edit window boundary | Inclusive (≤ 30 min) | Exclusive | None: the only edit is at +18 min |
| A US address with no zone (#2042, Hawaii) | PARTNER, as rule 2 says | Hold for a person | #2042 |
| Unknown SKU | Can't be stocked anywhere, so rule 7 → PARTNER | Reject or hold | None after uppercasing |
| PARTNER capacity | Unlimited, never checked | Has its own stock | None in the data |
| WH-NV in Part A | Enabled, as the config says; the ops notes only apply in Part B | Disable it now | See `routes-nv-off.txt` |

## Data decisions: the only liberties taken

Each one is a named, switchable normalization in `src/router.ts`, and every order it touches carries a note in `routes.txt`.

| Data problem | Order(s) | Decision | Why |
|---|---|---|---|
| ZIP stored as the number `2134` | #2033 | Left-pad numeric ZIPs to 5 digits → `02134` | JSON numbers drop leading zeros. The state (MA) confirms 021 is Boston. A *string* ZIP kept its zeros, so a short string is treated as malformed, not padded. |
| ZIP+4 `07030-1834` | #2039 | Use the first 5 digits | It's a valid US format. |
| SKU in lowercase `nw-mag-90` | #2045 | Trim and uppercase SKUs | Same product. Reading it literally sends a US order to the international partner. |
| Bundle `NW-BNDL-ESS` | #2040, #2056 | Expand into its catalog components before checking stock | No warehouse stocks the bundle SKU. It ships as its components, in one parcel. |
| `order_edited` adds a line 18 min after creation | #2041 | Fold edits into the order before routing; route it once, at its creation-time position | The brief says to route each order once with everything in it, in creation order. |
| Same SKU from a bundle and a loose line | (none in data) | Quantities are summed per SKU before the stock check | Otherwise an order could pass the check line by line and still overdraw. |

Edits outside the 30-minute window, edits for unknown orders, duplicate `order_created` events and unknown event types are reported as warnings and not applied. An invalid quantity stops the run with the order number rather than guessing.

## These decisions change other orders, not just their own

Stock is shared, so a normalization moves later orders too. The tests pin these down:

- Ignoring the #2041 edit sends #2041 to WH-NV, which leaves WH-GA with one more Vitamin D, so **#2050 moves to WH-GA and #2056 to WH-NV**.
- Not expanding bundles sends #2040 and #2056 to PARTNER, and **#2050 moves to WH-GA**.
- #2039 uses WH-NJ's last 2 magnesium units, which is why #2040 skips NJ (zone 2) for GA (zone 5).
- The literal ZIP and SKU readings only change their own order (#2033 and #2045 → PARTNER).

## How the output was verified

- `test/router.test.ts` contains an **independent reference model**. It re-reads the raw JSON and re-derives every route with separate code (its own parsing, and a lexicographic minimum instead of the router's comparator). The router must match it on every order, and on final stock, for the files as given and with WH-NV down.
- **Stock conservation:** for every warehouse and SKU, start − end equals the sum reserved by orders routed there; every movement continues from where the previous order left the stock; nothing goes negative; disabled warehouses receive nothing.
- **Source-file facts** the normalizations depend on (the numeric ZIP, the lowercase SKU, the 18-minute edit, the unstocked bundle SKU) are asserted directly against the raw files.
- **Rules the data never exercises** get synthetic tests: rule 6 priority (with equal finite and equal unlimited cover, and warehouses listed out of priority order), edits outside the window, orphan edits, duplicate orders, and a bundle plus a loose unit of the same product.
- **Explanations are tested too:** the deciding rule for representative orders, and the per-warehouse checks for #2050 and for #2056's rule 7 PARTNER with WH-NV down.
- **The tests can fail:** I broke the router on purpose twice (tie-break preferring *less* cover, and skipping stock reservation). The suite caught both (3 and 5 failing tests), then I restored the original byte-for-byte.

## Part B

Answers and reasoning: [`PART-B.md`](PART-B.md).

`npm run route:nv-off` writes [`routes-nv-off.txt`](routes-nv-off.txt): the same router with WH-NV disabled, per the ops notes (water damage). It is the basis for Question 1, not a Part A result. The Part A configuration in `data/` is left exactly as given.

## Visual inspector

`npm run dev` opens a small Vite page (at `http://localhost:5173`) that runs the same `src/router.ts` and only displays what it returns.

- **Toolbar:** pick a scenario (Part A, Question 1 with WH-NV down, Question 2 option 1 with WH-NV and WH-GA off), switch warehouses on or off, or turn off a data fix to see the literal reading of the file.
- **Order list:** where each order ships from and the rule that decided it. In any scenario other than Part A, a column shows the Part A result; "Show only these" filters to the orders that changed.
- **Selected order:** a plain-language reason, each warehouse's zone, stock check, days of cover and result, the inventory before → after the order, and the raw events from `orders.json`. Clicking a stock number lists how it changed through the day; clicking an entry jumps to that order. The up and down arrow keys step through orders.

It's a tool for inspecting results; the tests are the proof.

## Layout

```
data/              source files from the brief, unchanged
src/router.ts      normalization + routing (pure, shared by CLI, tests and UI)
src/main.ts        CLI
test/              node:test suite
ui/, index.html    optional inspector
routes.txt         Part A output
routes-nv-off.txt  same router with WH-NV disabled (Question 1 basis)
PART-B.md          Part B answers
```

## AI use

Built with Claude Code. I directed the decisions (which data fixes to make, what not to change, option 2 for Question 2) and had every result checked against the source files and an independent model in the tests rather than trusted.

The full conversation is in [`ai-conversation/transcript.md`](ai-conversation/transcript.md), generated from the local session log by [`convert-transcript.mjs`](ai-conversation/convert-transcript.mjs). It keeps every message, tool call and tool result as they happened, mistakes included. The only changes are a few private details (names of my private repositories and an unrelated file name), each marked `[REDACTED: …]`. The file's header explains what it doesn't contain and why.
