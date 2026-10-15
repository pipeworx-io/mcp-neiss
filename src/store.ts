/**
 * D1 reads for mcps/neiss.
 *
 * Data: CPSC's own annual NEISS public-use files, collapsed offline into
 * national weighted injury estimates per (year, product_code, age_bucket)
 * by scripts/neiss/aggregate-neiss.mjs, then loaded into a D1 database the
 * gateway hands this pack as `_d1` (pack-manifest "d1Binding": "NEISS_DB")
 * by scripts/neiss/load-data.mjs — never a bundled import; see that
 * script's header for why (fleet #3060: a baked dataset blocked every
 * lane's gateway deploy for about an hour on 2026-10-14).
 *
 * NOTE on placeholders: D1's local smoke shim mangles NUMBERED placeholders
 * (`?1`) — every statement here uses plain, positional `?` (same note as
 * mcps/asrs-reports/src/store.ts).
 */

export interface D1Like {
  prepare(sql: string): D1StmtLike;
}
export interface D1StmtLike {
  bind(...values: unknown[]): D1StmtLike;
  all<T = Record<string, unknown>>(): Promise<{ results: T[] }>;
  first<T = Record<string, unknown>>(): Promise<T | null>;
}

export class StoreUnavailableError extends Error {
  constructor() {
    super(
      'neiss: the NEISS estimate store is not bound in this runtime (no _d1). These tools only answer through the Pipeworx gateway; a standalone install has no data to read.',
    );
    this.name = 'StoreUnavailableError';
  }
}
export function requireDb(d1: unknown): D1Like {
  if (!d1 || typeof (d1 as D1Like).prepare !== 'function') throw new StoreUnavailableError();
  return d1 as D1Like;
}

export const SOURCE = {
  source: 'CPSC, National Electronic Injury Surveillance System (NEISS) annual public-use file',
};

export interface EstimateRow {
  data_year: number;
  product_code: string;
  age_bucket: string;
  estimated_injuries: number;
  sample_cases: number;
  unstable_estimate: number; // 0/1 from SQLite
}

export async function latestYear(db: D1Like): Promise<number | null> {
  const row = await db.prepare('SELECT MAX(data_year) AS y FROM neiss_national_estimates').first<{ y: number | null }>();
  return row?.y ?? null;
}

export async function estimatesForProductYears(
  db: D1Like,
  productCode: string,
  ageBucket: string,
  fromYear: number,
  toYear: number,
): Promise<EstimateRow[]> {
  const { results } = await db
    .prepare(
      'SELECT data_year, product_code, age_bucket, estimated_injuries, sample_cases, unstable_estimate ' +
        'FROM neiss_national_estimates WHERE product_code = ? AND age_bucket = ? AND data_year >= ? AND data_year <= ? ' +
        'ORDER BY data_year ASC',
    )
    .bind(productCode, ageBucket, fromYear, toYear)
    .all<EstimateRow>();
  return results;
}

export async function topProducts(db: D1Like, year: number, ageBucket: string, limit: number): Promise<EstimateRow[]> {
  const { results } = await db
    .prepare(
      'SELECT data_year, product_code, age_bucket, estimated_injuries, sample_cases, unstable_estimate ' +
        'FROM neiss_national_estimates WHERE data_year = ? AND age_bucket = ? ORDER BY estimated_injuries DESC LIMIT ?',
    )
    .bind(year, ageBucket, limit)
    .all<EstimateRow>();
  return results;
}

export async function rowCount(db: D1Like): Promise<number> {
  const row = await db.prepare('SELECT COUNT(*) AS n FROM neiss_national_estimates').first<{ n: number }>();
  return Number(row?.n ?? 0);
}
