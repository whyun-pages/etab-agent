'use strict';
/**
 * The tools a turn offers the model, built for its switches.
 *
 * This file decides WHICH tools a turn gets and in what order; each tool is
 * defined in defs/. The switches are the permission boundary — a read-only
 * turn has no edit tool, file access off means no file tool, only readwrite
 * can write or run a shell — so they stay here, together, where they can be
 * read in one pass rather than inferred from a dozen files.
 *
 * The order is part of the prompt: the model sees the tools as listed.
 */

import os from 'node:os';
import type { AgentTool } from '@earendil-works/pi-agent-core';
import { fileOperations } from './file-operations.ts';
import type { Pi } from '../pi.ts';
import { SHELL_TOOL } from '../prompt.ts';
import {
  createReadTool,
  createWriteTool,
  createEditTool,
  createLsTool,
  createFindTool,
  createGrepTool,
} from './pi-tools/fs-tools.ts';
import { createBashTool, createPowerShellTool } from './pi-tools/shell.ts';
import { toolContext } from './tool-context.ts';
import type { TurnState, Capabilities } from './tool-context.ts';
import { readRowsTool } from './defs/read-rows.ts';
import { saveFileTool } from './defs/save-file.ts';
import { fetchUrlTool } from './defs/fetch.ts';
import { queryTableTool } from './defs/query-table.ts';
import { readAttachmentTool } from './defs/read-attachment.ts';
import { importFileTool } from './defs/import-file.ts';
import { editTools } from './defs/edit.ts';
import { askUserTool } from './defs/ask-user.ts';

export type { TurnState } from './tool-context.ts';

/** The tools for one turn, closed over its state. */
export function buildTools(ai: Pi['ai'], state: TurnState, caps: Capabilities): AgentTool<any>[] {
  const ctx = toolContext(ai, state, caps);
  const tools: AgentTool<any>[] = [readRowsTool(ctx)];

  if (caps.canSave) tools.push(saveFileTool(ctx));
  if (caps.canFetch) tools.push(fetchUrlTool(ctx));
  tools.push(queryTableTool(ctx));

  // Offered with file access too: import_file turns files into attachments
  // mid-turn, and the tool list is fixed when the turn starts.
  if (caps.attachments.length || caps.fileAccess !== 'off') tools.push(readAttachmentTool(ctx));

  if (caps.fileAccess !== 'off') {
    // pi's tools, through this turn's checked operations. Relative paths
    // resolve against the user's home: the server's own working directory is
    // nothing the user is looking at. `~` means the same home the checks use.
    const { Type } = ctx.schemas;
    const home = caps.fileOptions.home || os.homedir();
    const ops = fileOperations(caps.fileOptions, state.writes);
    tools.push(
      createReadTool(Type, home, ops.read, home),
      createLsTool(Type, home, ops.ls, home),
      createFindTool(Type, home, ops.find, home),
      createGrepTool(Type, home, ops.grep, home),
    );
    if (caps.fileAccess === 'readwrite') {
      tools.push(
        createWriteTool(Type, home, ops.write, home),
        createEditTool(Type, home, ops.edit, home),
        SHELL_TOOL === 'powershell' ? createPowerShellTool(Type, home) : createBashTool(Type, home),
      );
    }
    tools.push(importFileTool(ctx, home));
  }

  if (!caps.canEdit) return tools;
  tools.push(...editTools(ctx), askUserTool(ctx));
  return tools;
}
