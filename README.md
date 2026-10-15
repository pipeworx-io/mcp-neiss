# @pipeworx/neiss

National WEIGHTED estimates of consumer-product-related emergency-department
injuries in the US, from CPSC's injury-surveillance system — "how many people
were injured by X", "what products injure people the most". Separate from the
`cpsc` pack, which covers CPSC's RECALL database (saferproducts.gov); this is
the injury-surveillance side.

Part of [Pipeworx](https://pipeworx.io) — an MCP gateway connecting AI agents to 1807+ live data sources. This is an independent, unofficial integration — not affiliated with, endorsed by, or published by the upstream provider.

## Tools

- `neiss_injuries(product_code | product, year | from_year/to_year, age_range?)`
  — national weighted estimate for one product, one year or a year range, plus
  the underlying sample size. Flags any estimate built from a small sample as
  unstable rather than reporting it as precise.
- `neiss_top_products(year?, age_range?, limit?)` — rank products by national
  weighted injury estimate for one year.
- `neiss_product_codes(query, limit?)` — search the ~800 product/activity codes
  by keyword to find the exact code `neiss_injuries` wants. Entirely local, no
  live call.

## Auth

Keyless.

## Data sources

- CPSC, National Electronic Injury Surveillance System (NEISS) — a nationally
  representative sample of hospital emergency departments, operated by CPSC
  for 45+ years, that produces the national estimates behind "how many X
  injuries" questions. CPSC publishes a complete calendar year of
  emergency-department-visit records at a time, not a per-request query API;
  the per-product, per-year weighted estimates these tools serve are computed
  OFFLINE from CPSC's own published annual files — see "Updating the data"
  below. The product/activity code list is CPSC's own NEISS Coding Manual
  (Appendix H).

## Updating the data

The estimate store holds `(year, product_code, age_bucket)` rows, not
case-level records — nothing patient-identifying is ever loaded. To add a
year:

```bash
# 1. Download + aggregate (safe to run anywhere; no credentials needed).
#    Downloads CPSC's own annual files directly; takes ~1 minute for 2 years.
node scripts/neiss/aggregate-neiss.mjs --years 2025 --out /tmp/neiss-2025.json

# 2. Load into the store (needs `wrangler` logged in to the production
#    Cloudflare account — run by whoever holds that, not by the pack author).
node scripts/neiss/load-data.mjs --file /tmp/neiss-2025.json
```

A case counts toward EVERY product code it lists (NEISS allows up to three
per case), matching CPSC's own per-product convention — a two-product case is
not split 50/50. `age_bucket` `'all'` sums every case for that product
regardless of age, including unknown age; the other buckets
(`0-4`/`5-14`/`15-24`/`25-44`/`45-64`/`65+`) only include cases with a known
age. Age under 2 years is coded by CPSC in completed months, not years — the
aggregator converts both to fractional years before bucketing.

Estimates from fewer than ~20 sampled cases are flagged `unstable_estimate`
rather than silently reported as precise, per CPSC's own convention for small
cells.

## Quick Start

Add to your MCP client (Claude Desktop, Cursor, Windsurf, etc.):

```json
{
  "mcpServers": {
    "neiss": {
      "url": "https://gateway.pipeworx.io/neiss/mcp"
    }
  }
}
```

### What this endpoint actually serves

`tools/list` at `https://gateway.pipeworx.io/neiss/mcp` returns the tools in the table
above **plus the shared Pipeworx meta-tools** — `ask_pipeworx`,
`discover_tools`, `search_within`, `remember`/`recall` and the rest of the
gateway-wide set. So the tool count you see is larger than this table: a
single-pack endpoint currently lists roughly 30 shared tools alongside the
pack's own. The connection's `initialize` response states its exact scope, and
is the authoritative answer for a given day.

This is deliberate, not multiplexing by accident. The meta-tools are what let a
scoped connection answer a question this pack does not cover — via
`ask_pipeworx`, which routes across the whole catalog — without you adding a
second MCP server. There is currently no way to mount a pack endpoint without
them; if the extra schemas cost you more context than the routing is worth,
connect to the full gateway once rather than to several pack endpoints.

Or connect to the full Pipeworx gateway to get every pack's tools listed
directly, instead of just this one's:

```json
{
  "mcpServers": {
    "pipeworx": {
      "url": "https://gateway.pipeworx.io/mcp"
    }
  }
}
```

Both URLs reach the same gateway and the same 1807+ data sources. The
only difference is which pack's tools are listed **directly**; `ask_pipeworx`
reaches all of them from either one.

## No MCP client? Call it over HTTP

```bash
curl -X POST https://gateway.pipeworx.io/v1/tools/neiss_injuries \
  -H 'Content-Type: application/json' \
  -d '{"product_code":"1842","year":2024}'
```

No account needed for the first calls. Inspect any tool: `GET https://gateway.pipeworx.io/v1/tools/neiss_injuries`. Find one: `POST https://gateway.pipeworx.io/v1/tools/search_packs` with `{"query":"..."}`.

## Standalone (no gateway account)

This package also runs as a local stdio MCP server — no Pipeworx account, no
gateway round-trip:

```json
{
  "mcpServers": {
    "neiss": {
      "command": "npx",
      "args": ["-y", "@pipeworx/mcp-neiss"]
    }
  }
}
```

Or run it directly to confirm it starts:

```bash
npx -y @pipeworx/mcp-neiss
```

It speaks MCP over stdin/stdout and answers `initialize`/`tools/list`/`tools/call`
for **only** this pack's tools — none of the shared meta-tools the gateway
connection above adds. Same source, same tools, no ask_pipeworx routing.

## Using with ask_pipeworx

Instead of calling tools directly, you can ask questions in plain English —
this works on the pack endpoint above as well as on the full gateway:

```
ask_pipeworx({ question: "your question about Neiss data" })
```

The gateway picks the right tool and fills the arguments automatically.

## More

- [Docs and guides](https://pipeworx.io/docs)
- [pipeworx.io](https://pipeworx.io)

## License

MIT
