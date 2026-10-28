import * as vscode from 'vscode';
import * as fs from 'fs';
import { HostCommand, AppSettings, findDbConfig, findKingdeeConfig } from '../core/messaging';
import { toolById } from '../core/tool-registry';
import { doHttpRequest } from './http';
import { diffDictionaries } from '../dictionary/diffengine';
import { testConnection, introspect, saveDbPassword } from './db';
import { cryptoOps } from './crypto-ops';
import { parseKingdeeMetadata } from '../dictionary/kingdee';
import { ProjectStore, projectSecretKey, configHashOf, cacheSlot, CacheMeta } from './project-store';
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

/** 读文本文件：按 BOM 自动识别 UTF-16LE/BE、UTF-8 BOM（金蝶导出的数据字典 HTML 常为 UTF-16LE） */
async function readTextSmart(p: string): Promise<string> {
  const buf = await fs.promises.readFile(p);
  if (buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xfe) return new TextDecoder('utf-16le').decode(buf.subarray(2));
  if (buf.length >= 2 && buf[0] === 0xfe && buf[1] === 0xff) {
    try { return new TextDecoder('utf-16be').decode(buf.subarray(2)); } catch { /* 不支持 BE 时回退 UTF-8 */ }
  }
  if (buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) return buf.subarray(3).toString('utf8');
  return buf.toString('utf8');
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
        content: await readTextSmart(uris[0].fsPath),
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
      const { projectId, kind, configId, formIds } = payload as { projectId: string; kind: 'db' | 'kingdee'; configId?: string; formIds?: string[] };
      try {
        const cfg = projects().loadConfig(projectId);
        if (kind === 'db') {
          const c = findDbConfig(cfg, configId);
          if (!c?.host || !c?.database) return { ok: false, error: '本项目未配置数据库连接：请在「连接配置 → 数据库连接」填写主机与库名' };
          const d = await introspect({
            client: c.client || 'mysql', host: c.host, port: c.port, user: c.user,
            database: c.database, password: '', projectId, configId: c.id,
          } as any, context.secrets);
          const meta: CacheMeta = {
            kind, configId: c.id, configName: c.name, importedAt: new Date().toISOString(),
            configHash: configHashOf(cfg, 'db', c.id), tableCount: d.tables.length,
          };
          return { ok: true, dict: d, meta };
        }
        const c = findKingdeeConfig(cfg, configId);
        if (!c?.baseUrl) return { ok: false, error: '本项目未配置金蝶连接：请在「连接配置 → 金蝶云星空」填写站点地址' };
        // 表单标识：优先本次传入，其次用上次缓存里记的
        const ids = (formIds && formIds.length ? formIds : projects().loadCache(projectId, 'kingdee', c.id)?.meta?.formIds) || [];
        if (!ids.length) return { ok: false, error: '请先在「扩展字段 → 金蝶」填写至少一个表单标识（如 BD_MATERIAL）' };
        const r = await kingdeeFetchMetadata(ids, { projectId, configId: c.id }, context.secrets, (id) => projects().loadConfig(id));
        if (!r.ok || !r.text) return { ok: false, error: r.error || '拉取失败' };
        const d = parseKingdeeMetadata(r.text, '金蝶元数据');
        const meta: CacheMeta = {
          kind, configId: c.id, configName: c.name, importedAt: new Date().toISOString(),
          configHash: configHashOf(cfg, 'kingdee', c.id), formIds: ids, tableCount: d.tables.length,
        };
        return { ok: true, dict: d, meta };
      } catch (e: any) {
        return { ok: false, error: String(e?.message || e) };
      }
    }
    // 只有前端在冲突面板点过「应用」、确认合并成功后才调用，
    // 否则用户点了取消，缓存却已经是新的 → 显示"刚刚拉取"但字典没变，状态不一致
    case 'projectSaveCache': {
      const { projectId, kind, configId, dict, meta } = payload as {
        projectId: string; kind: 'db' | 'kingdee'; configId?: string; dict: any; meta?: any;
      };
      const cid = configId ?? meta?.configId;
      projects().saveCache(projectId, kind, dict, {
        kind,
        configId: cid,
        configName: meta?.configName,
        importedAt: meta?.importedAt || new Date().toISOString(),
        configHash: meta?.configHash ?? configHashOf(projects().loadConfig(projectId), kind, cid),
        formIds: meta?.formIds,
        tableCount: meta?.tableCount ?? dict?.tables?.length,
      }, cid);
      return true;
    }
    // 读取某类来源的上次拉取信息（时间 + 是否因改了连接而过期）
    case 'projectDiff': {
      const { projectId, otherId } = payload as { projectId: string; otherId: string };
      try {
        const a = projects().load(projectId);
        const b = projects().load(otherId);
        if (!a || !b) return { ok: false, error: '其中一个项目没有字典数据，无法比对' };
        // 跨项目比对是两份完整字典对比，必须用全量语义（含两边额外表）
        const items = diffDictionaries(a, b, { fullCompare: true });
        // 注意语义：diffDictionaries(当前, 对方) 里
        //   added   = 对方有、当前没有 → 仅对方项目有
        //   removed = 当前有、对方没有 → 仅当前项目有
        // 这里直接按"归属方"命名，避免调用方再靠记忆二次翻译
        const onlyOther = items.filter((x) => x.kind === 'added').length;
        const onlyCurrent = items.filter((x) => x.kind === 'removed').length;
        const modified = items.filter((x) => x.kind === 'modified').length;
        const pa = projects().getMeta(projectId);
        const pb = projects().getMeta(otherId);
        return {
          ok: true,
          summary: {
            added: onlyOther, removed: onlyCurrent, modified,
            onlyCurrent, onlyOther, total: items.length,
            leftName: pa?.name || '当前项目', rightName: pb?.name || '另一个项目',
          },
          items: items.slice(0, 500),
        };
      } catch (e: any) {
        return { ok: false, error: String(e?.message || e) };
      }
    }
    case 'projectCacheMeta': {
      const { projectId } = payload as { projectId: string };
      const cfg = projects().loadConfig(projectId);
      // 按具体配置逐条回传缓存状态（多配置下每条各自一个缓存槽）；key 用 cacheSlot
      const out: Record<string, { importedAt?: string; stale?: boolean; tableCount?: number; configHash?: string; configId?: string; configName?: string }> = {};
      const slots: { kind: 'db' | 'kingdee'; configId: string; configName?: string }[] = [
        ...(cfg.connections?.db || []).map((d) => ({ kind: 'db' as const, configId: d.id, configName: d.name })),
        ...(cfg.connections?.kingdee || []).map((k) => ({ kind: 'kingdee' as const, configId: k.id, configName: k.name })),
      ];
      for (const s of slots) {
        const c = projects().loadCache(projectId, s.kind, s.configId);
        if (!c) continue;
        out[cacheSlot(s.kind, s.configId)] = {
          importedAt: c.meta?.importedAt,
          tableCount: c.meta?.tableCount,
          stale: c.meta?.configHash !== configHashOf(cfg, s.kind, s.configId),
          configHash: c.meta?.configHash,
          configId: s.configId,
          configName: s.configName,
        };
      }
      return out;
    }
    case 'kingdeeTestConfig': {
      const { projectId, configId } = payload as { projectId: string; configId?: string };
      const cfg = projects().loadConfig(projectId);
      return await kingdeeTestProject(findKingdeeConfig(cfg, configId) || {}, context.secrets, projectId, configId);
    }
    case 'projectGetConfig': {
      const { id } = payload as { id: string };
      // defaults 只用于 UI 上的"从全局设置填充"，运行时拉取连接一律读项目配置
      const cfg = projects().loadConfig(id);
      const hash: Record<string, string> = {};
      for (const d of cfg.connections?.db || []) hash[cacheSlot('db', d.id)] = configHashOf(cfg, 'db', d.id);
      for (const k of cfg.connections?.kingdee || []) hash[cacheSlot('kingdee', k.id)] = configHashOf(cfg, 'kingdee', k.id);
      return {
        config: cfg,
        defaults: { kingdee: globalKingdeeDefaults() },
        hash,
      };
    }
    case 'projectSaveConfig': {
      const { id, config } = payload as { id: string; config: any };
      projects().saveConfig(id, config);
      return true;
    }
    case 'projectSaveSecret': {
      const { projectId, kind, configId, values } = payload as { projectId: string; kind: 'db' | 'kingdee'; configId?: string; values: Record<string, string> };
      const key = projectSecretKey(projectId, kind, configId);
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
      const { projectId, kind, configId } = payload as { projectId: string; kind: 'db' | 'kingdee'; configId?: string };
      const raw = await context.secrets.get(projectSecretKey(projectId, kind, configId));
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
      let bundle: any;
      try {
        bundle = JSON.parse(raw);
      } catch {
        vscode.window.showErrorMessage('导入失败：文件不是有效的 JSON');
        return null;
      }
      try {
        return projects().importBundle(bundle);
      } catch (e: any) {
        vscode.window.showErrorMessage(`导入失败：${e?.message || e}`);
        return null;
      }
    }
    // ---------- 金蝶云星空 ----------
    case 'kingdeeFetchMetadata': {
      const p = payload as { formIds: string[]; projectId?: string; configId?: string; appSecret?: string; password?: string };
      return await kingdeeFetchMetadata(p.formIds || [], { projectId: p.projectId, configId: p.configId, appSecret: p.appSecret, password: p.password }, context.secrets, (id) => projects().loadConfig(id));
    }
    case 'kingdeeSaveSecret': {
      const { appSecret, password, projectId, configId } = payload as { appSecret?: string; password?: string; projectId?: string; configId?: string };
      await saveSecret(context.secrets, appSecret, password, projectId, configId);
      return true;
    }
    case 'readTextFileAt': {
      // 仅用于重新解析用户此前主动选择过的文件；失败返回 ok:false 而非抛错
      const { path } = payload as { path: string };
      try {
        return { ok: true, content: await readTextSmart(path) };
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
    // 密码学/字符编码运算（哈希/AES/DES/GBK/随机数）：全同步，纯 node:crypto + ICU
    case 'cryptoOps': {
      return cryptoOps(payload as import('../core/messaging').CryptoOpsPayload);
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
