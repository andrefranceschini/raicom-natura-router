# Part B notes

## Question 1: where each order ships today

Basis: the Part A router plus the ops notes. WH-NV is out (water damage), so it is disabled. WH-GA stays on, because its picking delay is the Question 2 decision. Full output: [`routes-nv-off.txt`](routes-nv-off.txt).

| Order | Ships from | Why |
|---|---|---|
| #2033 | WH-NJ | The ZIP is the number `2134`, i.e. `02134` (Boston). The state, MA, confirms it. NJ is zone 3. |
| #2037 | Partner | Canada (rule 1). |
| #2040 | WH-GA | The bundle is Vitamin D + Magnesium. NJ (zone 2) has had no magnesium since #2039, so GA (zone 5) is next. |
| #2041 | WH-GA | The edit adds a multivitamin. NV (zone 2) is down, and it has no multivitamin anyway. GA (zone 7) beats NJ (zone 8). |
| #2045 | WH-GA | `nw-mag-90` is `NW-MAG-90`. GA is zone 3. |
| #2050 | WH-NJ | GA (zone 1) has 1 Vitamin D left and the order needs 2. NJ is zone 5. |
| #2051 | WH-GA | NV (zone 2) is down. GA (zone 7) beats NJ (zone 8). |

None of these needs a person to decide. Worth raising on the call: with NV off, **#2056 (a New Jersey customer) goes to the international partner under rule 7**, because GA runs out of Vitamin D at #2051 and NJ has no magnesium. Also, the brief says "question 4" in Question 1; it means Question 2.

## Question 2: keep routing to WH-GA (option 2)

**Decision:** keep routing to WH-GA as normal. Disable WH-NV in the router, tell customers routed to GA their new delivery date, and monitor GA's picking backlog daily.

**Why not the others**

- **Option 1 (GA off)** is worse than option 3 in every case. The 70% of GA orders without a close alternative would pay about $2.35 more to arrive about as late, in transit instead of in picking. With NV down and NJ out of magnesium, some have no domestic warehouse at all: in today's orders, turning GA off sends 11 of 26 to the international partner instead of 3.
- **Option 4** sends orders to a flooded warehouse.
- **Option 3** is the best on paper (about $50/day so roughly 126 orders/day arrive about 1.5 days sooner). But it depends on two things nobody has confirmed:
  - New routing logic has to be built, deployed and removed safely within days. The router still shows NV enabled a day after the flood.
  - NJ has to have the capacity and stock for about 126 extra orders a day. It is already out of magnesium.

The delay is temporary, everything still ships, and option 2 can be reversed at any time.

**When to reassess:** if GA's backlog grows beyond 2 business days, or recovery slips past Monday.

**When option 3 comes back:** only if, by Wednesday midday, operations confirms NJ can take the volume and the rule can ship with an automatic expiry on Monday. After that, too little of the window is left to justify the risk.

**What the 26 orders can and can't show:** GA had 15 of them, and 6 had NJ within one zone (40%, 95% interval about 20–64%). That's too few to estimate a share, so I rely on Priya's figures. The structural facts don't depend on sample size: NJ has no magnesium, and with NV down some orders have no domestic warehouse.
