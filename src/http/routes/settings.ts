'use strict';
/**
 * Settings: read, save, and a test call to the configured model.
 *
 *   GET  /api/settings
 *   POST /api/settings
 *   POST /api/settings/test
 */

import path from 'node:path';
import type { Router } from '@koa/router';
import { isFileAccessMode, FILE_ACCESS_MODES } from '../../agent/file-access.ts';
import { isModelApi } from '../../agent/model.ts';
import { parseBlocklist } from '../../agent/fetch-url.ts';
import { chat, stripReasoning } from '../../agent/llm.ts';
import { fail, jsonBody, bodyOf, isLocalRequest, messageOf } from '../respond.ts';
import type { RouteDeps } from './index.ts';
import type { SettingsPatch } from '../../store/settings.ts';
/** Entries either blocklist may hold: well past any real list, small enough to check per request. */ const MAX_BLOCKLIST = 500;

export function settingsRoutes(router: Router, { state }: RouteDeps): void {
  router.get('/api/settings', async (ctx) => {
    ctx.body = { ok: true, settings: await state.settings.publicSettings() };
  });

  router.post('/api/settings', jsonBody('64kb'), async (ctx) => {
    const body = bodyOf(ctx);
    const patch: SettingsPatch = {};
    // Only these keys are writable, and an absent key means "leave it". An
    // empty string for apiKey is meaningful ("clear it"), so test for presence
    // rather than truthiness.
    if ('api' in body) {
      // Refused rather than defaulted: a protocol the panel did not offer is a
      // client bug, and silently saving OpenAI-compatible instead would leave
      // the user debugging the wrong endpoint.
      if (!isModelApi(body.api)) return fail(ctx, 400, `不支持的接口协议：${String(body.api).slice(0, 40)}`);
      patch.api = body.api;
    }
    if ('apiKey' in body) patch.apiKey = String(body.apiKey || '').trim();
    if ('baseUrl' in body) patch.baseUrl = String(body.baseUrl || '').trim();
    if ('model' in body) patch.model = String(body.model || '').trim();
    if ('useForAttachments' in body) patch.useForAttachments = Boolean(body.useForAttachments);
    if ('chatCanEdit' in body) patch.chatCanEdit = Boolean(body.chatCanEdit);
    if ('chatConfirmEdits' in body) patch.chatConfirmEdits = Boolean(body.chatConfirmEdits);
    if ('chatCanFetch' in body) patch.chatCanFetch = Boolean(body.chatCanFetch);
    if ('chatCanSave' in body) patch.chatCanSave = Boolean(body.chatCanSave);
    if ('fetchBlocklist' in body) {
      // Normalised here, once, so the stored list is what the matcher compares
      // against: bare lower-case hosts, no scheme or path.
      const list = parseBlocklist(body.fetchBlocklist);
      if (list.length > MAX_BLOCKLIST) return fail(ctx, 400, `禁止抓取的网站最多 ${MAX_BLOCKLIST} 条`);
      patch.fetchBlocklist = list;
    }
    if ('chatFileAccess' in body || 'fileBlocklist' in body) {
      // The switch to this machine's files is this machine's to flip. With
      // `--host` the settings page is reachable from the LAN, and a neighbour
      // turning file access on would then read files here.
      if (!isLocalRequest(ctx)) return fail(ctx, 403, '只能在本机修改文件访问设置');
      if ('chatFileAccess' in body) {
        if (!isFileAccessMode(body.chatFileAccess))
          return fail(ctx, 400, `文件访问只能是 ${FILE_ACCESS_MODES.join('、')}`);
        patch.chatFileAccess = body.chatFileAccess;
      }
      if ('fileBlocklist' in body) {
        const raw = Array.isArray(body.fileBlocklist)
          ? body.fileBlocklist
          : String(body.fileBlocklist || '').split(/\r?\n/);
        const list = raw.map((x) => String(x).trim()).filter(Boolean);
        if (list.length > MAX_BLOCKLIST) return fail(ctx, 400, `禁止访问的路径最多 ${MAX_BLOCKLIST} 条`);
        patch.fileBlocklist = list;
      }
    }
    if ('exportDir' in body) {
      const dir = String(body.exportDir || '').trim();
      // Relative would mean "relative to wherever the app was started", which
      // is not a place the user chose.
      if (dir && !path.isAbsolute(dir)) return fail(ctx, 400, '导出目录必须是完整路径，例如 D:\\导出');
      patch.exportDir = dir;
    }
    // Refuse a base URL that is not http(s): anything else would be sent a
    // bearer token by a client that cannot speak the scheme.
    if (patch.baseUrl && !/^https?:\/\//i.test(patch.baseUrl)) {
      return fail(ctx, 400, '接口地址必须以 http:// 或 https:// 开头');
    }

    await state.settings.save(patch);
    // Echo the SAFE projection only — never the key back to the caller.
    ctx.body = { ok: true, settings: await state.settings.publicSettings() };
  });

  router.post('/api/settings/test', async (ctx) => {
    if (!(await state.settings.isConfigured())) return fail(ctx, 400, '请先填写 API key、接口地址和模型名');
    try {
      // The budget has to cover the model THINKING plus the answer. A reasoning
      // model (MiniMax-M3 and friends) spends tokens on its reasoning block
      // before it emits anything, so a tiny cap gets consumed by reasoning
      // alone and the reply comes back empty — while the provider still reports
      // success. Seen live: maxTokens 16 returned "<think>…</think>" with no
      // answer. 512 leaves ample room.
      const raw = await chat({
        credentials: await state.settings.secrets(),
        messages: [{ role: 'user', content: '回复两个字：可用' }],
        maxTokens: 512,
        timeoutMs: 30_000,
      });
      // Show the answer, not the reasoning — but keep the raw text as evidence
      // when there is no answer at all.
      const reply = stripReasoning(raw);
      if (!reply) {
        ctx.body = {
          ok: false,
          error: '模型只返回了思考过程，没有给出回答。可能模型名有误，或所选接口协议与该模型不匹配。',
          raw: String(raw).slice(0, 400),
        };
        return;
      }
      ctx.body = { ok: true, reply: String(reply).slice(0, 200) };
    } catch (err) {
      // The provider's own words are the useful part; pass them through.
      ctx.body = { ok: false, error: messageOf(err) };
    }
  });
}
