import { useEffect, useState } from "react";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { phrase, say, type Locale } from "../lib/i18n";

export const PAGE_SIZES = [10, 20, 50, 100] as const;
const PAGE_SIZE_KEY = "3xui-page-size";
const DEFAULT_PAGE_SIZE = 20;

function readPageSize(): number {
  try {
    const saved = Number(window.localStorage.getItem(PAGE_SIZE_KEY));
    if ((PAGE_SIZES as readonly number[]).includes(saved)) return saved;
  } catch { /* The page size preference is optional. */ }
  return DEFAULT_PAGE_SIZE;
}

export interface Pager {
  page: number;
  size: number;
  pages: number;
  total: number;
  /** Index of the first row on this page. */
  start: number;
  setPage: (page: number) => void;
  setSize: (size: number) => void;
}

/** Page state for one table; the page size is shared by every table and remembered. */
export function usePager(total: number): Pager {
  const [size, setSizeState] = useState(readPageSize);
  const [requested, setPage] = useState(1);
  const pages = Math.max(1, Math.ceil(total / size));
  const page = Math.min(Math.max(1, requested), pages);
  useEffect(() => { if (requested !== page) setPage(page); }, [requested, page]);
  const setSize = (next: number) => {
    setSizeState(next);
    setPage(1);
    try { window.localStorage.setItem(PAGE_SIZE_KEY, String(next)); } catch { /* The page size preference is optional. */ }
  };
  return { page, size, pages, total, start: (page - 1) * size, setPage, setSize };
}

export function pageSlice<T>(rows: readonly T[], pager: Pager): T[] {
  return rows.slice(pager.start, pager.start + pager.size);
}

function pageWindow(page: number, pages: number): Array<number | "gap-start" | "gap-end"> {
  if (pages <= 7) return Array.from({ length: pages }, (_unused, index) => index + 1);
  const items: Array<number | "gap-start" | "gap-end"> = [1];
  const from = Math.max(2, page - 1);
  const to = Math.min(pages - 1, page + 1);
  if (from > 2) items.push("gap-start");
  for (let value = from; value <= to; value += 1) items.push(value);
  if (to < pages - 1) items.push("gap-end");
  items.push(pages);
  return items;
}

export function Pagination({ locale, pager }: { locale: Locale; pager: Pager }) {
  if (pager.total === 0) return null;
  const first = pager.start + 1;
  const last = Math.min(pager.total, pager.start + pager.size);
  return <nav className="pagination" aria-label={say(locale, "分页", "Pagination")}>
    <div className="pagination-meta">
      <span className="pagination-range">{phrase(locale, "第 {a}-{b} 条，共 {n} 条", "{a}-{b} of {n}", { a: first, b: last, n: pager.total })}</span>
      <label className="pagination-size">
        <span>{say(locale, "每页", "Per page")}</span>
        <select value={pager.size} aria-label={say(locale, "每页显示条数", "Rows per page")} onChange={(event) => pager.setSize(Number(event.target.value))}>
          {PAGE_SIZES.map((option) => <option key={option} value={option}>{option}</option>)}
        </select>
      </label>
    </div>
    <div className="pagination-pages">
      <button type="button" className="pagination-step" disabled={pager.page <= 1} aria-label={say(locale, "上一页", "Previous page")} onClick={() => pager.setPage(pager.page - 1)}><ChevronLeft size={15} /></button>
      {pageWindow(pager.page, pager.pages).map((item) => typeof item === "number"
        ? <button key={item} type="button" className={`pagination-page ${item === pager.page ? "active" : ""}`} aria-current={item === pager.page ? "page" : undefined} onClick={() => pager.setPage(item)}>{item}</button>
        : <span key={item} className="pagination-gap" aria-hidden="true">…</span>)}
      <button type="button" className="pagination-step" disabled={pager.page >= pager.pages} aria-label={say(locale, "下一页", "Next page")} onClick={() => pager.setPage(pager.page + 1)}><ChevronRight size={15} /></button>
    </div>
  </nav>;
}
