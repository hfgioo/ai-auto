/**
 * Settings IPC handlers — 注册 channel:* 系列 IPC
 *
 * 命名空间：channel
 *   channel:list          (args: { category? })                       => ChannelConfigDTO[]
 *   channel:get           (args: { id })                              => ChannelConfigDTO | null
 *   channel:count         ()                                          => number
 *   channel:create        (args: ChannelConfigInput)                  => ChannelConfigDTO
 *   channel:update        (args: { id, patch })                       => ChannelConfigDTO
 *   channel:delete        (args: { id })                              => boolean
 *   channel:bulkImport    (args: { configs: ChannelConfigInput[] })   => { imported }
 *   channel:setDefault    (args: { category, channelId, modelId? })   => MediaDefaultDTO
 *   channel:getDefault    (args: { category })                        => MediaDefaultDTO | null
 *   channel:listDefaults  ()                                          => MediaDefaultDTO[]
 *   channel:deleteDefault (args: { category })                        => boolean
 *   app-kv:get            (args: { key })                              => { value, updatedAt }
 *   app-kv:set            (args: { key, value })                       => { updatedAt }
 *   app-kv:delete         (args: { key })                              => boolean
 */
import { ipcMain, webContents } from 'electron';
import { logger } from 'ee-core/log';
import { ensureServicesReady } from '../index';
import type { MediaCategory } from '../storage/repositories/settingsInterfaces';
import type { ChannelConfigInput } from './ChannelConfigService';
import {
  listChannelConfigs,
  getChannelConfig,
  createChannelConfig,
  updateChannelConfig,
  deleteChannelConfig as deleteConfig,
  bulkImportChannelConfigs,
  countChannelConfigs,
  setMediaDefault,
  getMediaDefault,
  listMediaDefaults,
  deleteMediaDefault,
} from './ChannelConfigService';
import { SqliteAppSettingsKvRepository } from '../storage/repositories/SqliteAppSettingsKvRepository';

function ok<T>(data: T) {
  return { ok: true as const, data };
}

function fail(code: string, message: string) {
  return { ok: false as const, code, message };
}

const appKvRepo = new SqliteAppSettingsKvRepository();

function broadcastChannelChanged(payload: Record<string, unknown>): void {
  try {
    for (const wc of webContents.getAllWebContents()) {
      wc.send('channel:changed', payload);
    }
  } catch (err) {
    logger.error('[settings-ipc] broadcast channel:changed failed');
  }
}

let registered = false;

export function registerSettingsIpc(): void {
  if (registered) {
    logger.warn('[settings-ipc] already registered, skip');
    return;
  }
  registered = true;

  logger.info('[settings-ipc] registering channel:* handlers');

  ipcMain.handle('channel:list', async (_e, args?: { category?: MediaCategory }) => {
    try {
      await ensureServicesReady();
      return ok(listChannelConfigs(args?.category));
    } catch (err: any) {
      logger.error('[channel:list]', err);
      return fail('LIST_ERROR', err.message ?? String(err));
    }
  });

  ipcMain.handle('channel:get', async (_e, args: { id: string }) => {
    try {
      await ensureServicesReady();
      return ok(getChannelConfig(args.id));
    } catch (err: any) {
      logger.error('[channel:get]', err);
      return fail('GET_ERROR', err.message ?? String(err));
    }
  });

  ipcMain.handle('channel:count', async () => {
    try {
      await ensureServicesReady();
      return ok(countChannelConfigs());
    } catch (err: any) {
      logger.error('[channel:count]', err);
      return fail('COUNT_ERROR', err.message ?? String(err));
    }
  });

  ipcMain.handle('channel:create', async (_e, args: ChannelConfigInput) => {
    try {
      await ensureServicesReady();
      const result = createChannelConfig(args);
      broadcastChannelChanged({ type: 'create', category: result.category, id: result.id });
      return ok(result);
    } catch (err: any) {
      logger.error('[channel:create]', err);
      return fail('CREATE_ERROR', err.message ?? String(err));
    }
  });

  ipcMain.handle(
    'channel:update',
    async (_e, args: { id: string; patch: Partial<ChannelConfigInput> }) => {
      try {
        await ensureServicesReady();
        const result = updateChannelConfig(args.id, args.patch);
        broadcastChannelChanged({ type: 'update', category: result.category, id: result.id });
        return ok(result);
      } catch (err: any) {
        logger.error('[channel:update]', err);
        return fail('UPDATE_ERROR', err.message ?? String(err));
      }
    },
  );

  ipcMain.handle('channel:delete', async (_e, args: { id: string }) => {
    try {
      await ensureServicesReady();
      const result = deleteConfig(args.id);
      if (result) broadcastChannelChanged({ type: 'delete', id: args.id });
      return ok(result);
    } catch (err: any) {
      logger.error('[channel:delete]', err);
      return fail('DELETE_ERROR', err.message ?? String(err));
    }
  });

  ipcMain.handle(
    'channel:bulkImport',
    async (_e, args: { configs: ChannelConfigInput[] }) => {
      try {
        await ensureServicesReady();
        const result = bulkImportChannelConfigs(args.configs ?? []);
        if (result.imported > 0) broadcastChannelChanged({ type: 'bulkImport', imported: result.imported });
        return ok(result);
      } catch (err: any) {
        logger.error('[channel:bulkImport]', err);
        return fail('BULK_IMPORT_ERROR', err.message ?? String(err));
      }
    },
  );

  ipcMain.handle(
    'channel:setDefault',
    async (
      _e,
      args: { category: MediaCategory; channelId: string; modelId?: string | null; payload?: Record<string, unknown> },
    ) => {
      try {
        await ensureServicesReady();
        const result = setMediaDefault(args.category, args.channelId, args.modelId ?? null, args.payload);
        broadcastChannelChanged({ type: 'setDefault', category: result.category, channelId: result.channelId });
        return ok(result);
      } catch (err: any) {
        logger.error('[channel:setDefault]', err);
        return fail('SET_DEFAULT_ERROR', err.message ?? String(err));
      }
    },
  );

  ipcMain.handle('channel:getDefault', async (_e, args: { category: MediaCategory }) => {
    try {
      await ensureServicesReady();
      return ok(getMediaDefault(args.category));
    } catch (err: any) {
      logger.error('[channel:getDefault]', err);
      return fail('GET_DEFAULT_ERROR', err.message ?? String(err));
    }
  });

  ipcMain.handle('channel:listDefaults', async () => {
    try {
      await ensureServicesReady();
      return ok(listMediaDefaults());
    } catch (err: any) {
      logger.error('[channel:listDefaults]', err);
      return fail('LIST_DEFAULTS_ERROR', err.message ?? String(err));
    }
  });

  ipcMain.handle('channel:deleteDefault', async (_e, args: { category: MediaCategory }) => {
    try {
      await ensureServicesReady();
      const result = deleteMediaDefault(args.category);
      if (result) broadcastChannelChanged({ type: 'deleteDefault', category: args.category });
      return ok(result);
    } catch (err: any) {
      logger.error('[channel:deleteDefault]', err);
      return fail('DELETE_DEFAULT_ERROR', err.message ?? String(err));
    }
  });

  ipcMain.handle('app-kv:get', async (_e, args: { key: string }) => {
    try {
      await ensureServicesReady();
      const row = appKvRepo.get(args.key);
      if (!row) return ok({ value: null, updatedAt: null });
      let value: unknown = null;
      try { value = JSON.parse(row.value_json); } catch { value = null; }
      return ok({ value, updatedAt: row.updated_at });
    } catch (err: any) {
      logger.error('[app-kv:get]', err);
      return fail('KV_GET_ERROR', err.message ?? String(err));
    }
  });

  ipcMain.handle('app-kv:set', async (_e, args: { key: string; value: unknown }) => {
    try {
      await ensureServicesReady();
      appKvRepo.set(args.key, JSON.stringify(args.value ?? null));
      return ok({ updatedAt: Date.now() });
    } catch (err: any) {
      logger.error('[app-kv:set]', err);
      return fail('KV_SET_ERROR', err.message ?? String(err));
    }
  });

  ipcMain.handle('app-kv:delete', async (_e, args: { key: string }) => {
    try {
      await ensureServicesReady();
      return ok(appKvRepo.delete(args.key));
    } catch (err: any) {
      logger.error('[app-kv:delete]', err);
      return fail('KV_DELETE_ERROR', err.message ?? String(err));
    }
  });
}
