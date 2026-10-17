'use strict';
/**
 * An (extended) M3U playlist as a table of channels.
 */

/** Chinese headers for the common extended-M3U attributes; others keep their key. */
const M3U_LABELS: Record<string, string> = {
  'tvg-name': '标识名',
  'tvg-id': '标识 ID',
  'tvg-logo': '台标',
  'group-title': '分组',
};

/**
 * An extended M3U playlist as rows: 频道名, each attribute that appears (in
 * order of first appearance), 播放地址. Null when the text is not a playlist
 * or has no entries.
 *
 * `#EXTINF:<duration> key="value" ...,<title>` — the title is everything
 * after the first comma outside quotes, since attribute values may contain
 * commas. The URL is the next line that is not a comment.
 */
export function m3uToMatrix(text: string): string[][] | null {
  const lines = text
    .replace(/^\uFEFF/, '')
    .split(/\r?\n/)
    .map((l) => l.trim());
  if (!lines.length || !/^#EXTM3U/i.test(lines[0])) return null;
  const entries: Array<{ title: string; attrs: Map<string, string>; url: string }> = [];
  let cur: { title: string; attrs: Map<string, string> } | null = null;
  for (const line of lines) {
    if (/^#EXTINF:/i.test(line)) {
      const body = line.slice(8);
      let comma = -1;
      let quoted = false;
      for (let i = 0; i < body.length; i++) {
        if (body[i] === '"') quoted = !quoted;
        else if (body[i] === ',' && !quoted) {
          comma = i;
          break;
        }
      }
      const head = comma < 0 ? body : body.slice(0, comma);
      const attrs = new Map<string, string>();
      for (const m of head.matchAll(/([\w-]+)="([^"]*)"/g)) attrs.set(m[1], m[2]);
      cur = { title: comma < 0 ? '' : body.slice(comma + 1).trim(), attrs };
    } else if (line && !line.startsWith('#') && cur) {
      entries.push({ ...cur, url: line });
      cur = null;
    }
  }
  if (!entries.length) return null;
  const keys: string[] = [];
  for (const e of entries) for (const k of e.attrs.keys()) if (!keys.includes(k)) keys.push(k);
  const header = ['频道名', ...keys.map((k) => M3U_LABELS[k] || k), '播放地址'];
  return [
    header,
    ...entries.map((e) => [e.title || e.attrs.get('tvg-name') || '', ...keys.map((k) => e.attrs.get(k) || ''), e.url]),
  ];
}
