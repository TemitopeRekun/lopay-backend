/**
 * Shared pagination contract for list endpoints (Milestone 4 — Scale).
 *
 * Every admin list returns this envelope so the frontend has a uniform shape to
 * page through, and no HTTP-reachable query can materialise an unbounded result
 * set: `limit` is always clamped to `MAX_PAGE_SIZE`.
 */
export interface Paginated<T> {
  items: T[];
  total: number;
  page: number;
  limit: number;
  totalPages: number;
}

export const DEFAULT_PAGE_SIZE = 50;
export const MAX_PAGE_SIZE = 200;

export interface PaginationArgs {
  page: number;
  limit: number;
  skip: number;
}

/**
 * Parse and CLAMP untrusted `page` / `limit` query values into safe Prisma
 * args. Invalid / missing values fall back to page 1 and the default size; an
 * over-large `limit` is capped at `maxLimit` so a caller cannot ask for the
 * whole table.
 */
export function parsePagination(
  pageRaw?: string | number | null,
  limitRaw?: string | number | null,
  opts: { defaultLimit?: number; maxLimit?: number } = {},
): PaginationArgs {
  const { defaultLimit = DEFAULT_PAGE_SIZE, maxLimit = MAX_PAGE_SIZE } = opts;

  const pageNum = Number(pageRaw);
  const page = Number.isInteger(pageNum) && pageNum > 0 ? pageNum : 1;

  const limitNum = Number(limitRaw);
  const limit =
    Number.isInteger(limitNum) && limitNum > 0
      ? Math.min(limitNum, maxLimit)
      : defaultLimit;

  return { page, limit, skip: (page - 1) * limit };
}

/** Wrap a page of rows + the total count into the standard envelope. */
export function paginate<T>(
  items: T[],
  total: number,
  page: number,
  limit: number,
): Paginated<T> {
  return {
    items,
    total,
    page,
    limit,
    totalPages: Math.ceil(total / limit),
  };
}
