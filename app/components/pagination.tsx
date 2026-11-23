"use client";
import { useEffect, useState } from "react";
import { useI18n } from "./preferences-provider";

/** Markets shown per page on market lists. */
export const PAGE_SIZE = 10;

/** Page state for a list: returns the visible slice and resets to the first
 * page whenever `resetKey` (e.g. search text or filter) changes.
 * Example: 29 items → pages of 10, 10, 9. */
export function usePage<T>(items: T[], resetKey: string) {
  const [page, setPage] = useState(1);
  useEffect(() => setPage(1), [resetKey]);
  const pages = Math.max(1, Math.ceil(items.length / PAGE_SIZE));
  const current = Math.min(page, pages);
  return {
    page: current,
    pages,
    total: items.length,
    slice: items.slice((current - 1) * PAGE_SIZE, current * PAGE_SIZE),
    setPage,
  };
}

/** Page numbers to show: first, last, and neighbours of the current page,
 * with `null` marking a gap. Example: page 5 of 9 → 1 … 4 5 6 … 9. */
function pageList(page: number, pages: number) {
  const keep = new Set([1, pages, page - 1, page, page + 1]);
  const list: (number | null)[] = [];
  for (let n = 1; n <= pages; n++) {
    if (!keep.has(n)) continue;
    if (list.length && n - (list[list.length - 1] as number) > 1)
      list.push(null);
    list.push(n);
  }
  return list;
}

export function Pagination({
  page,
  pages,
  total,
  onPage,
  targetId,
}: {
  page: number;
  pages: number;
  total: number;
  onPage: (page: number) => void;
  /** Element scrolled into view after a page change (the list's top). */
  targetId: string;
}) {
  const { t } = useI18n();
  if (pages <= 1) return null;
  const go = (n: number) => {
    onPage(n);
    document
      .getElementById(targetId)
      ?.scrollIntoView({ behavior: "smooth", block: "start" });
  };
  return (
    <nav className="pagination" aria-label={t("Pagination")}>
      <p className="pagination-range">
        {t("{from}–{to} of {total}", {
          from: String((page - 1) * PAGE_SIZE + 1),
          to: String(Math.min(page * PAGE_SIZE, total)),
          total: String(total),
        })}
      </p>
      <div className="pagination-pages">
        <button
          type="button"
          className="ui-btn"
          disabled={page === 1}
          onClick={() => go(page - 1)}
        >
          {t("← Previous")}
        </button>
        {pageList(page, pages).map((n, i) =>
          n === null ? (
            <span key={`gap-${i}`} className="pagination-gap">
              …
            </span>
          ) : (
            <button
              key={n}
              type="button"
              className={n === page ? "ui-btn ui-btn-primary" : "ui-btn"}
              aria-current={n === page ? "page" : undefined}
              onClick={() => go(n)}
            >
              {n}
            </button>
          ),
        )}
        <button
          type="button"
          className="ui-btn"
          disabled={page === pages}
          onClick={() => go(page + 1)}
        >
          {t("Next →")}
        </button>
      </div>
    </nav>
  );
}
