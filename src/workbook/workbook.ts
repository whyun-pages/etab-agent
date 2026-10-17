'use strict';
/**
 * Workbook spec — the single source of truth for what the agent is building.
 *
 * Why a spec and not an .xlsx
 * ---------------------------
 * The model proposes; this module decides. A model that is asked to "produce a
 * spreadsheet" will happily emit a malformed one, and a malformed file is the
 * one failure a user cannot work around: Excel refuses to open it, and there is
 * nothing to look at. So the model never touches XML. It emits a plain JSON
 * description (this spec), which is normalised and validated here, and only a
 * spec that passes is turned into a workbook by `toSheet`/`writeSpec`.
 *
 * That is the same boundary the template engine drew — the model decides what
 * the TEXT means, code decides what lands in a cell — moved to a new setting.
 *
 * Shape
 * -----
 *   {
 *     title: '销售汇总',
 *     sheets: [
 *       {
 *         name: '一月',
 *         columns: [{ key, header, type, format?, width? }],
 *         rows: [[v, v, ...], ...],
 *         totals: { enabled, label, sumColumns }
 *       }
 *     ]
 *   }
 *
 * Everything else is optional. Normalisation fills in what is missing, and it
 * is the reason a half-specified spec from a model is usable rather than
 * rejected.
 *
 * Types
 * -----
 *   text | number | integer | currency | percent | date | boolean | url
 *
 * A `url` cell is text that the xlsx carries as a real hyperlink: clickable in
 * Excel, styled like a link. Only http(s) and mailto targets get a link (see
 * `linkTarget`); anything else in a url column stays as plain text.
 *
 * A `date` is stored as a real Date (or an ISO string, coerced) and rendered to
 * an Excel serial number at write time. `dateToSerial` is shared with
 * the preview and pinned to the 1899-12-30 epoch that Excel actually uses.
 *
 * These types are the contract the rest of the tree types against — the
 * agent, the session store, the server and the preview all speak in
 * `WorkbookSpec`, not in `any`.
 *
 * Where the parts are
 * -------------------
 * This file is the door: everything below is re-exported whole, so callers
 * import from workbook.ts and never need to know which part holds a name.
 *
 *   spec-types.ts  the spec's types, the column types, the limits
 *   coerce.ts      one value into one column type
 *   normalize.ts   anything into a valid spec (normalizeSpec)
 *   validate.ts    whether to write it, and what is in it
 *   layout.ts      cells, styles and widths for the writer; writeSpec
 */

export * from './spec-types.ts';
export * from './coerce.ts';
export * from './normalize.ts';
export * from './validate.ts';
export * from './layout.ts';
