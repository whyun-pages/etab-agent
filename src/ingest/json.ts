'use strict';
/**
 * JSON and JSON Lines as a table, when they hold an array of records
 * somewhere; otherwise the caller keeps the text.
 */

import type { CellValue, Table } from './types.ts';
import { matrixToTable } from './table.ts';

export function tryParseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    /* try jsonl */
  }
  const lines = text.split(/\r?\n/).filter((l) => l.trim());
  if (lines.length > 1 || (lines.length === 1 && lines[0].trim().startsWith('{'))) {
    const objs: unknown[] = [];
    for (const line of lines) {
      try {
        objs.push(JSON.parse(line));
      } catch {
        return null;
      }
    }
    if (objs.length && objs.every((o) => o && typeof o === 'object')) return objs;
  }
  return null;
}

/** Flatten JSON into a table when it is an array of flat-ish objects. */
export function jsonToTable(data: unknown): Table | null {
  const arr = findObjectArray(data, 0);
  if (!arr) return null;

  const header: string[] = [];
  for (const item of arr.slice(0, 200)) {
    for (const k of Object.keys(item)) if (!header.includes(k)) header.push(k);
  }
  const rows = arr.map((item) => header.map((k) => flattenValue(item[k])));
  const table = matrixToTable([header, ...rows]);
  // matrixToTable may pick a different header row; force ours.
  table.header = header;
  table.rows = rows;
  table.headerIndex = 0;
  return table;
}

/**
 * Locate an array of objects anywhere in a JSON payload. API responses nest the
 * useful rows under a wrapper, so a shallow check on the top level is not enough.
 */
export function findObjectArray(data: unknown, depth: number): Array<Record<string, unknown>> | null {
  if (depth > 4) return null;
  if (Array.isArray(data)) {
    return data.length && data.every((x) => x && typeof x === 'object' && !Array.isArray(x))
      ? (data as Array<Record<string, unknown>>)
      : null;
  }
  if (data && typeof data === 'object') {
    const obj = data as Record<string, unknown>;
    // Prefer conventional payload keys before falling back to declaration order.
    const preferred = ['data', 'list', 'items', 'rows', 'records', 'result', 'results'];
    const keys = [...preferred.filter((k) => k in obj), ...Object.keys(obj)];
    for (const key of keys) {
      const found = findObjectArray(obj[key], depth + 1);
      if (found) return found;
    }
  }
  return null;
}

function flattenValue(v: unknown): CellValue {
  if (v === null || v === undefined) return null;
  if (typeof v === 'object') return JSON.stringify(v);
  return v as CellValue;
}
