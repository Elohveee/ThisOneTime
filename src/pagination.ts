/**
 * pagination.ts: splits a list into pages.
 *
 * Purpose:  Keep long release lists fast while every item stays reachable.
 * Clamping: A page beyond the end becomes the last valid page, so a list that
 *           shrinks can never leave the user on an empty page.
 * Testing:  A pure function with no DOM access.
 */

export const PAGE_SIZE = 50;

/** One page of items, with the numbers needed to describe it. */
export interface Page<T> {
  items: T[];
  /** The current page, starting at 1. */
  page: number;
  pageCount: number;
  /** Position of the first item shown, starting at 1. Zero when empty. */
  first: number;
  /** Position of the last item shown. Zero when empty. */
  last: number;
  total: number;
}

/** Returns the requested page, clamped to the pages that exist. */
export function paginate<T>(items: readonly T[], requested: number, pageSize = PAGE_SIZE): Page<T> {
  const total = items.length;
  const pageCount = Math.max(1, Math.ceil(total / pageSize));
  const page = Math.min(Math.max(1, Math.trunc(requested) || 1), pageCount);
  const start = (page - 1) * pageSize;
  const visible = items.slice(start, start + pageSize);
  return {
    items: visible,
    page,
    pageCount,
    first: total ? start + 1 : 0,
    last: start + visible.length,
    total,
  };
}
