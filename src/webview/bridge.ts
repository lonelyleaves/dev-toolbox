import { WebviewMsg, WvResponse, WvPush, HostCommand, HttpResponseData, DbConnInfo, AppSettings, ProjectMeta , ProjectConfig } from '../core/messaging';
import { DictionaryModel } from '../dictionary/model';

declare const acquireVsCodeApi: () => {
  postMessage(msg: unknown): void;
  getState(): unknown;
  setState(s: unknown): void;
};

interface Bridge {
  post: (msg: WebviewMsg) => void;
  pending: Map<number, (r: WvResponse) => void>;
  pushHandlers: ((p: WvPush) => void)[];
}

const vscodeApi = acquireVsCodeApi();

export const bridge: Bridge = {
  post: (msg) => vscodeApi.postMessage(msg),
  pending: new Map(),
  pushHandlers: [],
};

window.addEventListener('message', (e) => {
  const msg = e.data as WebviewMsg;
  if (msg.kind === 'response') {
    const cb = bridge.pending.get(msg.id);
    if (cb) {
      bridge.pending.delete(msg.id);
      cb(msg);
    }
  } else if (msg.kind === 'push') {
    for (const h of bridge.pushHandlers) h(msg);
  }
});

import { hostCall, CryptoOpsPayload, CryptoOpsResult } from '../core/messaging';

export function call<T = unknown>(cmd: HostCommand, payload?: unknown, timeoutMs?: number): Promise<T> {
  return hostCall<T>(bridge.post, bridge.pending, cmd, payload, timeoutMs);
}

export const host = {
  getSettings: () => call<AppSettings>('getSettings'),
  setPanelTitle: (toolId: string) => call('setPanelTitle', { toolId }),
  copyText: (t: string) => call('copyText', t),
  getClipboard: () => call<string>('getClipboard'),
  showMessage: (level: 'info' | 'warn' | 'error', text: string) => call('showMessage', { level, text }),
  persistState: (key: string, value: unknown) => call('persistState', { key, value }),
  readState: <T = unknown>(key: string) => call<T | undefined>('readState', { key }),
  saveTextFile: (defaultName: string, content: string) => call<boolean>('saveTextFile', { defaultName, content }),
  saveBinaryFile: (defaultName: string, base64: string) => call<boolean>('saveBinaryFile', { defaultName, base64 }),
  openTextFile: () => call<{ name: string; path?: string; content: string } | null>('openTextFile'),
  readTextFileAt: (path: string) => call<{ ok: boolean; content?: string; error?: string }>('readTextFileAt', { path }),

  // ---------- 项目库（数据字典持久化，跨工作区复用） ----------
  projectList: () => call<{ currentId: string | null; projects: ProjectMeta[] }>('projectList'),
  projectCreate: (name: string) => call<ProjectMeta>('projectCreate', { name }),
  projectSwitch: (id: string) => call<boolean>('projectSwitch', { id }),
  projectRename: (id: string, name: string) => call<boolean>('projectRename', { id, name }),
  projectDelete: (id: string) => call<boolean>('projectDelete', { id }),
  projectClear: (id: string) => call<boolean>('projectClear', { id }),
  projectLoad: (id: string) => call<DictionaryModel | null>('projectLoad', { id }),
  projectSave: (id: string, dict: DictionaryModel) => call<boolean>('projectSave', { id, dict }),
  projectExport: (id: string, defaultName?: string) => call<boolean>('projectExport', { id, defaultName }),
  projectImport: () => call<ProjectMeta | null>('projectImport'),
  projectGetConfig: (id: string) =>
    call<{ config: ProjectConfig; defaults: { kingdee?: any }; hash: Record<string, string> }>('projectGetConfig', { id }),
  projectSaveConfig: (id: string, config: ProjectConfig) => call<boolean>('projectSaveConfig', { id, config }),
  projectSaveSecret: (projectId: string, kind: 'db' | 'kingdee', values: Record<string, string>, configId?: string) =>
    call<boolean>('projectSaveSecret', { projectId, kind, values, configId }),
  projectSync: (projectId: string, kind: 'db' | 'kingdee', configId?: string, formIds?: string[]) =>
    call<{ ok: boolean; dict?: any; meta?: any; error?: string }>('projectSync', { projectId, kind, configId, formIds }, 120000),
  projectDiff: (projectId: string, otherId: string) =>
    call<{ ok: boolean; summary?: { added: number; removed: number; modified: number; total: number; leftName?: string; rightName?: string }; items?: any[]; error?: string }>(
      'projectDiff', { projectId, otherId }, 60000,
    ),
  projectSaveCache: (projectId: string, kind: 'db' | 'kingdee', dict: any, meta?: any, configId?: string) =>
    call<boolean>('projectSaveCache', { projectId, kind, dict, meta, configId }),
  projectCacheMeta: (projectId: string) =>
    call<Record<string, { importedAt?: string; stale?: boolean; tableCount?: number; configHash?: string; configId?: string; configName?: string }>>('projectCacheMeta', { projectId }),
  kingdeeTestConfig: (projectId: string, configId?: string) => call<{ ok: boolean; message: string }>('kingdeeTestConfig', { projectId, configId }, 60000),
  projectReadSecretExists: (projectId: string, kind: 'db' | 'kingdee', configId?: string) => call<string[]>('projectReadSecretExists', { projectId, kind, configId }),

  // ---------- 金蝶云星空 ----------
  kingdeeFetchMetadata: (formIds: string[], opts?: { projectId?: string; configId?: string; appSecret?: string; password?: string }) =>
    call<{ ok: boolean; text?: string; error?: string }>('kingdeeFetchMetadata', { formIds, ...(opts || {}) }, 60000),
  kingdeeSaveSecret: (appSecret?: string, password?: string, projectId?: string, configId?: string) =>
    call<boolean>('kingdeeSaveSecret', { appSecret, password, projectId, configId }),
  openBinaryFile: () => call<{ name: string; base64: string } | null>('openBinaryFile'),
  httpRequest: (payload: any) => call<HttpResponseData>('httpRequest', payload, (payload.timeoutMs ?? 30000) + 5000),
  dbTestConnection: (info: DbConnInfo) => call<string>('dbTestConnection', info, 20000),
  dbIntrospect: (info: DbConnInfo) => call<DictionaryModel>('dbIntrospect', info, 120000),
  dbSavePassword: (info: DbConnInfo, password: string) => call('dbSavePassword', { info, password }),

  // ---------- 密码学 / 字符编码运算（宿主 node:crypto + ICU） ----------
  cryptoOps: (payload: CryptoOpsPayload) => call<CryptoOpsResult>('cryptoOps', payload),
};

/** 通知宿主 webview 已就绪 */
export function notifyReady() {
  bridge.post({ kind: 'push', event: 'ready' as any, toolId: '' } as any);
}
