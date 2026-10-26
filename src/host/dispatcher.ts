import * as vscode from 'vscode';
import * as fs from 'fs';
import { HostCommand, AppSettings } from '../core/messaging';
import { toolById } from '../core/tool-registry';
import { doHttpRequest } from './http';
import { testConnection, introspect, saveDbPassword } from './db';
import { parseKingdeeMetadata } from '../dictionary/kingdee';
import { ProjectStore, projectSecretKey, configHashOf, CacheMeta } from './project-store';
import { kingdeeFetchMetadata, saveSecret, KingdeeFetchResult, globalKingdeeDefaults, kingdeeTestProject } from './kingdee';

let context: vscode.ExtensionContext;
let store: ProjectStore | null = null;

/** 项目库（懒加载：globalStorageUri 目录按需创建） */
function projects(): ProjectStore {
  if (!store) {
    const uri = context.globalStorageUri;
    fs.mkdirSync(uri.fsPath, { recursive: true });
    store = new ProjectStore(uri);
  }
  return store;
}

export function initHost(ctx: vscode.ExtensionContext) {
  context = ctx;
}

export async function handleHostCommand(cmd: HostCommand, payload: any, panel: vscode.WebviewPanel): Promise<unknown> {
  switch (cmd) {
    case 'getSettings': {
      const cfg = vscode.workspace.getConfiguration('devToolbox');
      const settings: AppSettings = {
        curl: { timeoutMs: cfg.get('curl.timeoutMs'), maxResponseSize: cfg.get('curl.maxResponseSize') },
        sqlFormat: { dialect: cfg.get('sqlFormat.dialect'), keywordCase: cfg.get('sqlFormat.keywordCase') },
        historySize: cfg.get('general.historySize') ?? 20,
        naming: {
          tablePrefix: cfg.get('dictionary.naming.tablePrefix'),
          requireComment: cfg.get('dictionary.naming.requireComment'),
          requirePrimaryKey: cfg.get('dictionary.naming.requirePrimaryKey'),
          forbiddenTypes: cfg.get('dictionary.naming.forbiddenTypes'),
        },
      };
      return settings;
    }
    case 'copyText':
      await vscode.env.clipboard.writeText(String(payload));
      return true;
    case 'setPanelTitle': {
      const tool = toolById(String((payload as any)?.toolId ?? ''));
      if (tool) panel.title = `${tool.label} - DevToolbox`;
      return true;
    }
    case 'getClipboard':
      return await vscode.env.clipboard.readText();
    case 'showMessage': {
      const { level, text } = payload as { level: 'info' | 'warn' | 'error'; text: string };
      if (level === 'error') void vscode.window.showErrorMessage(text);
      else if (level === 'warn') void vscode.window.showWarningMessage(text);
      else void vscode.window.showInformationMessage(text);
      return true;
    }
    case 'persistState': {
      const { key, value } = payload as { key: string; value: unknown };
      await context.workspaceState.update(key, value);
      return true;
    }
    case 'readState': {
      const { key } = payload as { key: string };
      return context.workspaceState.get(key);
    }
    case 'saveTextFile': {
      const { defaultName, content } = payload as { defaultName: string; content: string };
      const uri = await vscode.window.showSaveDialog({ defaultUri: vscode.Uri.file(defaultName) });
      if (!uri) return false;
      await fs.promises.writeFile(uri.fsPath, content, 'utf8');
      return true;
    }
    case 'saveBinaryFile': {
      const { defaultName, base64 } = payload as { defaultName: string; base64: string };
      const uri = await vscode.window.showSaveDialog({ defaultUri: vscode.Uri.file(defaultName) });
      if (!uri) return false;
      await fs.promises.writeFile(uri.fsPath, Buffer.from(base64, 'base64'));
      return true;
    }
    case 'openTextFile': {
      const uris = await vscode.window.showOpenDialog({ canSelectMany: false });
      if (!uris || uris.length === 0) return null;
      // 带上完整路径：字典缓存要记住来源，解析规则升级后可自动重解析而不必让用户重选文件
      return {
        name: uris[0].fsPath.split('/').pop() || uris[0].fsPath,
        path: uris[0].fsPath,
        content: await fs.promises.readFile(uris[0].fsPath, 'utf8'),
      };
    }
    // ---------- 项目库（数据字典持久化） ----------
    case 'projectList':
      return projects().list();
    case 'projectCreate': {
      const { name } = payload as { name: string };
      return projects().create(name || '未命名项目');
    }
    case 'projectSwitch': {
      const { id } = payload as { id: string };
      projects().setCurrent(id);
      return true;
    }
    case 'projectRename': {
      const { id, name } = payload as { id: string; name: string };
      projects().rename(id, name);
      return true;
    }
    case 'projectDelete': {
      const { id } = payload as { id: string };
      projects().remove(id);
      return true;
    }
    case 'projectClear': {
      const { id } = payload as { id: string };
      projects().clear(id);
      return true;
    }
    case 'projectLoad': {
      const { id } = payload as { id: string };
      return projects().load(id);
    }
    case 'projectSave': {
      const { id, dict } = payload as { id: string; dict: any };
      projects().save(id, dict);
      return true;
    }
    // 用本项目的连接重新拉取：结果写缓存（带配置指纹），返回给前端走冲突面板合并
    case 'projectSync': {
      const { projectId, kind, formIds } = payload as { projectId: string; kind: 'db' | 'kingdee'; formIds?: string[] };
      try {
        const cfg = projects().loadConfig(projectId);
        if (kind === 'db') {
          const c = cfg.connections?.db;
          if (!c?.host || !c?.database) return { ok: false, error: '本项目未配置数据库连接：请在「连接配置 → 数据库连接」填写主机与库名' };
          const d = await introspect({
            client: c.client || 'mysql', host: c.host, port: c.port, user: c.user,
            database: c.database, password: '', projectId,
          } as any, context.secrets);
          const meta: CacheMeta = {
            kind: 'db', importedAt: new Date().toISOString(),
            configHash: configHashOf(cfg, 'db'), tableCount: d.tables.length,
          };
          projects().saveCache(projectId, 'db', d, meta);
          return { ok: true, dict: d, meta };
        }
        const c = cfg.connections?.kingdee;
        if (!c?.baseUrl) return { ok: false, error: '本项目未配置金蝶连接：请在「连接配置 → 金蝶云星空」填写站点地址' };
        // 表单标识：优先本次传入，其次用上次缓存里记的
        const ids = (formIds && formIds.length ? formIds : projects().loadCache(projectId, 'kingdee')?.meta?.formIds) || [];
        if (!ids.length) return { ok: false, error: '请先在「扩展字段 → 金蝶」填写至少一个表单标识（如 BD_MATERIAL）' };
        const r = await kingdeeFetchMetadata(ids, { projectId }, context.secrets, (id) => projects().loadConfig(id));
        if (!r.ok || !r.text) return { ok: false, error: r.error || '拉取失败' };
        const d = parseKingdeeMetadata(r.text, '金蝶元数据');
        const meta: CacheMeta = {
          kind: 'kingdee', importedAt: new Date().toISOString(),
          configHash: configHashOf(cfg, 'kingdee'), formIds: ids, tableCount: d.tables.length,
        };
        projects().saveCache(projectId, 'kingdee', d, meta);
        return { ok: true, dict: d, meta };
      } catch (e: any) {
        return { ok: false, error: String(e?.message || e) };
      }
    }
    // 读取某类来源的上次拉取信息（时间 + 是否因改了连接而过期）
    case 'projectCacheMeta': {
      const { projectId } = payload as { projectId: string };
      const cfg = projects().loadConfig(projectId);
      const out: Record<string, { importedAt?: string; stale?: boolean; tableCount?: number }> = {};
      for (const kind of ['db', 'kingdee'] as const) {
        const c = projects().loadCache(projectId, kind);
        if (!c) continue;
        out[kind] = {
          importedAt: c.meta?.importedAt,
          tableCount: c.meta?.tableCount,
          stale: c.meta?.configHash !== configHashOf(cfg, kind),
        };
      }
      return out;
    }
    case 'kingdeeTestConfig': {
      const { projectId } = payload as { projectId: string };
      const cfg = projects().loadConfig(projectId);
      return await kingdeeTestProject(cfg.connections?.kingdee || {}, context.secrets, projectId);
    }
    case 'projectGetConfig': {
      const { id } = payload as { id: string };
      // defaults 只用于 UI 上的"从全局设置填充"，运行时拉取连接一律读项目配置
      const cfg = projects().loadConfig(id);
      return {
        config: cfg,
        defaults: { kingdee: globalKingdeeDefaults() },
        hash: { db: configHashOf(cfg, 'db'), kingdee: configHashOf(cfg, 'kingdee') },
      };
    }
    case 'projectSaveConfig': {
      const { id, config } = payload as { id: string; config: any };
      projects().saveConfig(id, config);
      return true;
    }
    case 'projectSaveSecret': {
      const { projectId, kind, values } = payload as { projectId: string; kind: 'db' | 'kingdee'; values: Record<string, string> };
      const key = projectSecretKey(projectId, kind);
      const curRaw = await context.secrets.get(key);
      let cur: Record<string, string> = {};
      try { cur = curRaw ? JSON.parse(curRaw) : {}; } catch { cur = {}; }
      for (const [k, v] of Object.entries(values || {})) {
        if (v === undefined || v === null || v === '') continue; // 空值表示"不改"
        cur[k] = String(v);
      }
      await context.secrets.store(key, JSON.stringify(cur));
      return true;
    }
    case 'projectReadSecretExists': {
      const { projectId, kind } = payload as { projectId: string; kind: 'db' | 'kingdee' };
      const raw = await context.secrets.get(projectSecretKey(projectId, kind));
      let keys: string[] = [];
      try { keys = raw ? Object.keys(JSON.parse(raw)) : []; } catch { keys = []; }
      return keys;
    }

    case 'projectExport': {
      const { id, defaultName } = payload as { id: string; defaultName?: string };
      const bundle = projects().exportBundle(id);
      const uri = await vscode.window.showSaveDialog({ defaultUri: vscode.Uri.file(defaultName || 'project.dtproj.json') });
      if (!uri) return false;
      await fs.promises.writeFile(uri.fsPath, JSON.stringify(bundle, null, 2), 'utf8');
      return true;
    }
    case 'projectImport': {
      const uris = await vscode.window.showOpenDialog({ canSelectMany: false, filters: { '项目包': ['json'] } });
      if (!uris || uris.length === 0) return null;
      const raw = await fs.promises.readFile(uris[0].fsPath, 'utf8');
      return projects().importBundle(JSON.parse(raw));
    }
    // ---------- 金蝶云星空 ----------
    case 'kingdeeFetchMetadata': {
      const p = payload as { formIds: string[]; projectId?: string; appSecret?: string; password?: string };
      return await kingdeeFetchMetadata(p.formIds || [], { projectId: p.projectId, appSecret: p.appSecret, password: p.password }, context.secrets, (id) => projects().loadConfig(id));
    }
    case 'kingdeeSaveSecret': {
      const { appSecret, password, projectId } = payload as { appSecret?: string; password?: string; projectId?: string };
      await saveSecret(context.secrets, appSecret, password, projectId);
      return true;
    }
    case 'readTextFileAt': {
      // 仅用于重新解析用户此前主动选择过的文件；失败返回 ok:false 而非抛错
      const { path } = payload as { path: string };
      try {
        return { ok: true, content: await fs.promises.readFile(path, 'utf8') };
      } catch (e: any) {
        return { ok: false, error: String(e?.message || e) };
      }
    }
    case 'openBinaryFile': {
      const uris = await vscode.window.showOpenDialog({ canSelectMany: false });
      if (!uris || uris.length === 0) return null;
      const buf = await fs.promises.readFile(uris[0].fsPath);
      return { name: uris[0].fsPath, base64: buf.toString('base64') };
    }
    case 'httpRequest': {
      return await doHttpRequest(payload);
    }
    case 'dbTestConnection':
      return await testConnection(payload, context.secrets);
    case 'dbIntrospect':
      return await introspect(payload, context.secrets);
    case 'dbSavePassword': {
      const { info, password } = payload as { info: any; password: string };
      await saveDbPassword(info, password, context.secrets);
      return true;
    }
    default:
      throw new Error(`未知宿主命令: ${cmd}`);
  }
}
