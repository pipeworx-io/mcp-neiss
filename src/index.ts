interface McpToolDefinition {
  name: string;
  description: string;
  /** Human-facing one-liner (fleet #1967). Optional; consumers fall back to
   *  description. Kept in step with shared/src/types.ts — scripts/lib/
   *  check-inlined-types.mjs reports drift at publish time. */
  summary?: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, unknown>;
    required?: string[];
    anyOf?: Array<{ required: string[] }>;
    oneOf?: Array<{ required: string[] }>;
    allOf?: Array<{ required: string[] }>;
  };
  outputSchema?: Record<string, unknown>;
}

interface McpToolExport {
  tools: McpToolDefinition[];
  callTool: (name: string, args: Record<string, unknown>) => Promise<unknown>;
  meter?: { credits: number };
  cost?: Record<string, unknown>;
  provider?: string;
}

/**
 * NEISS — CPSC's national weighted consumer-product injury estimates.
 *
 * The National Electronic Injury Surveillance System is a nationally
 * representative sample of hospital emergency departments that CPSC has
 * operated for 45+ years. Every sampled case carries a statistical Weight;
 * summing that weight — never the raw case count — is how CPSC itself turns
 * the sample into a national estimate ("how many people nationwide were hurt
 * by X"). The `cpsc` pack already covers CPSC's RECALL database
 * (saferproducts.gov); this pack is the separate injury-SURVEILLANCE side.
 *
 * CPSC publishes each calendar year as a complete case-level file (one row
 * per ED visit, ~350k rows/year) rather than as a queryable API — its own
 * online query tool is a stateful ASP.NET form, not something any caller can
 * reach per-request. So the per-product, per-year weighted estimate behind
 * each tool here is computed OFFLINE by scripts/neiss/aggregate-neiss.mjs
 * from CPSC's own published annual files and loaded into D1 by
 * scripts/neiss/load-data.mjs (see src/store.ts); nothing case-level or
 * patient-level is kept anywhere downstream.
 */
import { PRODUCT_CODES } from './product-codes.js';
import { estimatesForProductYears, latestYear, requireDb, topProducts, type EstimateRow } from './store.js';

const SOURCE = 'CPSC, National Electronic Injury Surveillance System (NEISS) annual public-use file';

const AGE_BUCKETS = ['0-4', '5-14', '15-24', '25-44', '45-64', '65+'] as const;
type AgeBucket = (typeof AGE_BUCKETS)[number] | 'all';

const estimateSchema = {
  type: 'object',
  properties: {
    found: { type: 'boolean' },
    product_code: { type: 'string' },
    product_title: { type: 'string' },
    age_range: { type: 'string' },
    years: { type: 'array', items: { type: 'object' } },
    total_estimated_injuries: { type: 'number' },
    total_sample_cases: { type: 'number' },
    any_unstable: { type: 'boolean' },
    interpretation: { type: 'string' },
    source: { type: 'string' },
  },
  required: ['found'],
};

const tools: McpToolExport['tools'] = [
  {
    name: 'neiss_injuries',
    description:
      'National WEIGHTED estimate of consumer-product-related emergency-department injuries from CPSC\'s NEISS surveillance system — "how many people were injured by X", "ER visits from Y last year". Pass either an exact 4-digit product_code (see neiss_product_codes) or a free-text product name to resolve. Returns the national estimate (NOT a raw case count — NEISS samples ~100 hospitals and CPSC\'s own estimate is the sum of each sampled case\'s statistical weight) plus the underlying sample size. Estimates built from fewer than ~20 sampled cases are flagged unstable per CPSC convention and should not be quoted as precise. Optionally narrow by age_range. Covers emergency-department-treated injuries only, not deaths, hospitalizations elsewhere, or injuries that did not reach an ED.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        product_code: { type: 'string', description: 'Exact 4-digit CPSC NEISS product code, e.g. "1842". Leading zeros optional.' },
        product: { type: 'string', description: 'Free-text product name instead of a code, e.g. "stairs", "swimming pools". Matched case-insensitively against NEISS product titles; ambiguous matches return candidates instead of a number.' },
        year: { type: 'number', description: 'A single calendar year, e.g. 2024. Default: the most recent year loaded (the response says which).' },
        from_year: { type: 'number', description: 'Start of a year range instead of a single year (inclusive).' },
        to_year: { type: 'number', description: 'End of a year range (inclusive). Requires from_year.' },
        age_range: { type: 'string', enum: [...AGE_BUCKETS, 'all'], description: 'Patient age bucket at time of injury. Default "all" (every age, including unknown).' },
      },
    },
    outputSchema: estimateSchema,
  },
  {
    name: 'neiss_top_products',
    description:
      'Rank consumer products by national WEIGHTED emergency-department injury estimate for one year — "what injures people the most", "top products by ER visits", "most dangerous household products". Backed by the same CPSC NEISS national-estimate methodology as neiss_injuries (summed statistical weight, not raw case counts). Optionally narrow by age_range, e.g. age_range="0-4" for products that injure young children most.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        year: { type: 'number', description: 'Calendar year. Default: the most recent year loaded (the response says which).' },
        age_range: { type: 'string', enum: [...AGE_BUCKETS, 'all'], description: 'Default "all".' },
        limit: { type: 'number', description: 'Products to return, 1-50 (default 20).' },
      },
    },
    outputSchema: {
      type: 'object', properties: {
        found: { type: 'boolean' }, year: { type: 'number' }, age_range: { type: 'string' },
        products: { type: 'array', items: { type: 'object' } }, interpretation: { type: 'string' }, source: { type: 'string' },
      }, required: ['found'],
    },
  },
  {
    name: 'neiss_product_codes',
    description:
      'Look up CPSC NEISS product/activity codes by keyword, e.g. "pool", "ATV", "trampoline" — use this to find the exact product_code to pass to neiss_injuries, or just to see how CPSC categorizes a product. Entirely local (the fixed ~800-code NEISS coding-manual list); no live call.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        query: { type: 'string', description: 'Keyword to match against NEISS product titles, case-insensitive substring.' },
        limit: { type: 'number', description: 'Max matches, 1-100 (default 25).' },
      },
      required: ['query'],
    },
    outputSchema: {
      type: 'object', properties: {
        found: { type: 'boolean' }, total_matched: { type: 'number' }, returned: { type: 'number' },
        codes: { type: 'array', items: { type: 'object' } },
      }, required: ['found'],
    },
  },
];

function normalizeCode(raw: string): string {
  return raw.trim().padStart(4, '0');
}

/** Resolve a free-text product name against the local code list. */
function resolveProduct(query: string): { code: string; title: string }[] {
  const q = query.trim().toLowerCase();
  return PRODUCT_CODES.filter(([, title]) => title.toLowerCase().includes(q)).map(([code, title]) => ({ code, title }));
}

function titleFor(code: string): string | null {
  const hit = PRODUCT_CODES.find(([c]) => c === code);
  return hit ? hit[1] : null;
}

function normalizeAgeRange(raw: unknown): AgeBucket {
  if (typeof raw !== 'string' || !raw.trim() || raw.trim().toLowerCase() === 'all') return 'all';
  const v = raw.trim();
  if ((AGE_BUCKETS as readonly string[]).includes(v)) return v as AgeBucket;
  throw new Error(`Invalid age_range "${raw}". Use one of: all, ${AGE_BUCKETS.join(', ')}.`);
}

async function neissInjuries(args: Record<string, unknown>) {
  const db = requireDb(args._d1);
  const ageRange = normalizeAgeRange(args.age_range);

  let code: string;
  let title: string;
  const rawCode = typeof args.product_code === 'string' ? args.product_code.trim() : '';
  const rawProduct = typeof args.product === 'string' ? args.product.trim() : '';
  if (rawCode) {
    code = normalizeCode(rawCode);
    const known = titleFor(code);
    if (!known) {
      return { found: false, reason: 'unknown_product_code', message: `"${rawCode}" is not a NEISS product code. Use neiss_product_codes to search by name.` };
    }
    title = known;
  } else if (rawProduct) {
    const matches = resolveProduct(rawProduct);
    if (matches.length === 0) {
      return { found: false, reason: 'no_product_match', message: `No NEISS product title matches "${rawProduct}". Try neiss_product_codes with a broader keyword.` };
    }
    if (matches.length > 1) {
      return {
        found: false, reason: 'ambiguous_product',
        message: `"${rawProduct}" matches ${matches.length} NEISS product titles. Pick one and pass its product_code.`,
        candidates: matches.slice(0, 15).map((c) => ({ product_code: c.code, product_title: c.title })),
      };
    }
    code = matches[0].code;
    title = matches[0].title;
  } else {
    return { found: false, reason: 'missing_product', message: 'Pass either product_code (exact 4-digit NEISS code) or product (free-text name).' };
  }

  let fromYear = Number(args.from_year) || 0;
  let toYear = Number(args.to_year) || 0;
  const singleYear = Number(args.year) || 0;
  if (!fromYear && !toYear) {
    if (singleYear) { fromYear = singleYear; toYear = singleYear; }
    else {
      const latest = await latestYear(db);
      if (!latest) return { found: false, reason: 'store_empty', message: 'No NEISS data has been loaded into the estimate store yet.' };
      fromYear = latest; toYear = latest;
    }
  } else if (fromYear && !toYear) {
    toYear = fromYear;
  }

  const rows = await estimatesForProductYears(db, code, ageRange, fromYear, toYear);

  if (!rows.length) {
    return {
      found: false, reason: 'no_estimate',
      message: `No NEISS estimate for product_code ${code} (${title}) in ${fromYear}${toYear !== fromYear ? `-${toYear}` : ''} at age_range ${ageRange}. The product may genuinely have zero sampled cases in that window — try age_range "all" or a different year.`,
    };
  }

  const years = rows.map((r: EstimateRow) => ({
    year: r.data_year, estimated_injuries: r.estimated_injuries, sample_cases: r.sample_cases, unstable_estimate: !!r.unstable_estimate,
  }));
  const totalEstimated = years.reduce((s, y) => s + Number(y.estimated_injuries), 0);
  const totalCases = years.reduce((s, y) => s + Number(y.sample_cases), 0);
  const anyUnstable = years.some((y) => y.unstable_estimate);

  return {
    found: true,
    product_code: code,
    product_title: title,
    age_range: ageRange,
    years,
    total_estimated_injuries: Math.round(totalEstimated),
    total_sample_cases: totalCases,
    any_unstable: anyUnstable,
    interpretation:
      `National WEIGHTED estimate from CPSC's NEISS hospital sample, not a raw count — NEISS covers emergency-department-treated injuries only.` +
      (anyUnstable ? ' One or more years are based on fewer than ~20 sampled cases and should be treated as a rough order of magnitude, not a precise figure.' : ''),
    source: SOURCE,
  };
}

async function neissTopProducts(args: Record<string, unknown>) {
  const db = requireDb(args._d1);
  const ageRange = normalizeAgeRange(args.age_range);
  const limit = Math.min(50, Math.max(1, Number(args.limit) || 20));

  let year = Number(args.year) || 0;
  if (!year) {
    const latest = await latestYear(db);
    if (!latest) return { found: false, reason: 'store_empty', message: 'No NEISS data has been loaded into the estimate store yet.' };
    year = latest;
  }

  const rows = await topProducts(db, year, ageRange, limit);
  if (!rows.length) {
    return { found: false, reason: 'no_data', message: `No NEISS estimates loaded for ${year} at age_range ${ageRange}.` };
  }

  const products = rows.map((r: EstimateRow) => ({
    product_code: r.product_code,
    product_title: titleFor(r.product_code) ?? 'Unknown product code',
    estimated_injuries: r.estimated_injuries,
    sample_cases: r.sample_cases,
    unstable_estimate: !!r.unstable_estimate,
  }));

  return {
    found: true,
    year,
    age_range: ageRange,
    products,
    interpretation: `Ranked by national WEIGHTED estimate (summed NEISS statistical weight), not raw ED-visit counts.`,
    source: SOURCE,
  };
}

function neissProductCodes(args: Record<string, unknown>) {
  const query = typeof args.query === 'string' ? args.query.trim() : '';
  if (!query) return { found: false, reason: 'missing_query', message: 'Pass a keyword in query.' };
  const limit = Math.min(100, Math.max(1, Number(args.limit) || 25));
  const matches = resolveProduct(query);
  return {
    found: matches.length > 0,
    total_matched: matches.length,
    returned: Math.min(matches.length, limit),
    codes: matches.slice(0, limit).map((m) => ({ product_code: m.code, product_title: m.title })),
  };
}

async function callTool(name: string, args: Record<string, unknown>): Promise<unknown> {
  switch (name) {
    case 'neiss_injuries':
      return neissInjuries(args);
    case 'neiss_top_products':
      return neissTopProducts(args);
    case 'neiss_product_codes':
      return neissProductCodes(args);
    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

export default { tools, callTool, meter: { credits: 1 } } satisfies McpToolExport;
