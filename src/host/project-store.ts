/**
 * 项目库：把数据字典按"项目"存到扩展全局目录（context.globalStorageUri/projects）。
 *
 * 为什么用文件而不是 workspaceState：
 * - 跨工作区、跨窗口都能复用（workspaceState 换工作区就看不到）
 * - 容量无限制：1006 表的字典 JSON 实测 2.5MB，多项目累积会到几十 MB
 * - 可整体导出成项目包（.dtproj.json）分享/备份
 *
 * 目录结构：
 *   projects/index.json            { version, currentId, projects: ProjectMeta[] }
 *   projects/<id>/dict.json        DictionaryModel（含 sources 来源清单）
 */
import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { DictionaryModel } from '../dictionary/model';
import { ProjectMeta, ProjectConfig, emptyProjectConfig, normalizeConnections, findDbConfig, findKingdeeConfig, DEFAULT_CONFIG_ID } from '../core/messaging';

export type { ProjectMeta, ProjectConfig };

/**
 * 项目级 SecretStorage 键：凭据按项目 + 配置隔离。
 * configId 为 'default'/缺省时返回旧格式（老凭据直接命中，无损迁移）；新配置拼上 configId。
 */
export function projectSecretKey(projectId: string, kind: 'db' | 'kingdee', configId?: string): string {
  const base = `devtoolbox.project.${projectId}.${kind}`;
  return !configId || configId === DEFAULT_CONFIG_ID ? base : `${base}.${configId}`;
}

/** 缓存槽名：'default' 配置沿用旧 kind 名（旧缓存命中），其余拼 configId */
export function cacheSlot(kind: string, configId?: string): string {
  const safe = (v: string) => String(v || '').replace(/[^A-Za-z0-9_-]/g, '_');
  return !configId || configId === DEFAULT_CONFIG_ID ? safe(kind) : `${safe(kind)}__${safe(configId)}`;
}

export interface ProjectIndex {
  version: 1;
  currentId: string | null;
  projects: ProjectMeta[];
}

/** 项目包格式（导出/导入用，含完整字典与来源清单，不含任何凭据） */
export interface ProjectBundle {
  format: 'dev-toolbox-project';
  formatVersion: 1;
  exportedAt: string;
  project: ProjectMeta;
  dict: DictionaryModel;
  config?: ProjectConfig;
}

const INDEX_FILE = 'index.json';
const INDEX_BACKUP = 'index.bak';
const DICT_FILE = 'dict.json';
const CONFIG_FILE = 'config.json';
const CACHE_DIR = 'cache';

/** 原子写：先写同目录临时文件，再 rename 覆盖，避免半截 JSON */
function writeFileAtomic(file: string, data: string) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}-${Math.random().toString(36).slice(2, 8)}`;
  try {
    fs.writeFileSync(tmp, data, 'utf8');
    fs.renameSync(tmp, file);
  } catch (e) {
    try { fs.rmSync(tmp, { force: true }); } catch { /* 忽略清理失败 */ }
    throw e;
  }
}

function isValidIndex(x: any): x is ProjectIndex {
  return !!x && x.version === 1 && Array.isArray(x.projects)
    && (x.currentId === null || typeof x.currentId === 'string');
}

/** 缓存元信息：拉取时间、配置指纹、金蝶用到的表单标识 */
export interface CacheMeta {
  kind: string;
  importedAt: string;
  /** 连接配置指纹：改了连接 → 与当前指纹不一致 → 该来源缓存视为过期 */
  configHash: string;
  formIds?: string[];
  tableCount?: number;
  /** 多连接配置：这条缓存属于哪一条配置 */
  configId?: string;
  configName?: string;
}

/** 连接配置指纹（不含凭据）：用于判断"改了连接没"；按具体 configId 算 */
export function configHashOf(cfg: ProjectConfig | undefined, kind: 'db' | 'kingdee', configId?: string): string {
  const c = kind === 'db' ? findDbConfig(cfg, configId) : findKingdeeConfig(cfg, configId);
  if (!c) return '';
  const s = JSON.stringify(c);
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
  return `h${h.toString(36)}`;
}


/** 白名单式取连接配置：先归一化为数组，凭据字段无论如何都不会被写进 config.json 或导出包 */
function sanitizeConfig(cfg: ProjectConfig | undefined): ProjectConfig {
  const norm = normalizeConnections(cfg);
  const out = emptyProjectConfig();
  out.connections.db = (norm.connections.db || []).map((d) => ({
    id: d.id, name: d.name, autoName: d.autoName,
    client: d.client, host: d.host,
    port: Number.isFinite(Number(d.port)) ? Number(d.port) : undefined,
    user: d.user, database: d.database,
  }));
  out.connections.kingdee = (norm.connections.kingdee || []).map((k) => ({
    id: k.id, name: k.name,
    baseUrl: k.baseUrl, dbId: k.dbId, appId: k.appId, user: k.user,
    lcid: Number.isFinite(Number(k.lcid)) ? Number(k.lcid) : undefined,
    loginPath: k.loginPath, metadataPath: k.metadataPath, argStyle: k.argStyle, extraHeaders: k.extraHeaders,
  }));
  return out;
}
export class ProjectStore {
  private readonly root: string;

  constructor(storageUri: vscode.Uri) {
    this.root = path.join(storageUri.fsPath, 'projects');
    fs.mkdirSync(this.root, { recursive: true });
  }

  private get indexPath(): string { return path.join(this.root, INDEX_FILE); }
  private get indexBackupPath(): string { return path.join(this.root, INDEX_BACKUP); }
  private dirOf(id: string): string {
    // 项目 id 会拼进文件路径：拒绝分隔符/..，避免 Webview 传入路径穿越
    if (!/^[A-Za-z0-9_-]+$/.test(id || '')) throw new Error(`非法项目 id: ${id}`);
    return path.join(this.root, id);
  }

  private readIndex(): ProjectIndex {
    const read = (file: string): ProjectIndex | null => {
      try {
        const raw = fs.readFileSync(file, 'utf8');
        const idx = JSON.parse(raw);
        if (!isValidIndex(idx)) return null;
        return { version: 1, currentId: idx.currentId ?? null, projects: idx.projects ?? [] };
      } catch {
        return null;
      }
    };
    const main = read(this.indexPath);
    if (main) return main;
    const backup = read(this.indexBackupPath);
    if (backup) return backup;
    // 文件不存在 = 首次使用；文件存在但损坏 = 绝不能静默返回空索引，否则下一次写入会清空项目列表
    if (fs.existsSync(this.indexPath)) {
      throw new Error('项目索引损坏（index.json / index.bak 均无法读取）。已保留原文件，请先备份/修复 index.json');
    }
    return { version: 1, currentId: null, projects: [] };
  }

  private writeIndex(idx: ProjectIndex) {
    fs.mkdirSync(this.root, { recursive: true });
    // 只在现有 index 可解析时更新备份，避免把损坏内容复制进备份
    if (fs.existsSync(this.indexPath)) {
      try {
        const cur = JSON.parse(fs.readFileSync(this.indexPath, 'utf8'));
        if (isValidIndex(cur)) fs.copyFileSync(this.indexPath, this.indexBackupPath);
      } catch { /* 坏 index 不覆盖已有备份 */ }
    }
    writeFileAtomic(this.indexPath, JSON.stringify(idx, null, 2));
  }


  /** 取单个项目的元信息（名字等） */
  getMeta(id: string): ProjectMeta | undefined {
    return this.readIndex().projects.find((p) => p.id === id);
  }
  list(): { currentId: string | null; projects: ProjectMeta[] } {
    const idx = this.readIndex();
    return {
      currentId: idx.currentId,
      // 顺带算出每个项目的连接配置摘要，省得 UI 再为每个项目单独拉一次
      projects: idx.projects.map((p) => {
        try {
          const c = this.loadConfig(p.id);
          const dbs = c.connections?.db || [];
          const kds = c.connections?.kingdee || [];
          return {
            ...p,
            configSummary: {
              db: dbs.filter((d) => d.host && d.database).length,
              kingdee: kds.filter((k) => k.baseUrl).length,
            },
          };
        } catch { return { ...p, configSummary: { db: 0, kingdee: 0 } }; }
      }),
    };
  }

  create(name: string): ProjectMeta {
    const idx = this.readIndex();
    const id = `p_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
    const now = new Date().toISOString();
    const meta: ProjectMeta = { id, name, createdAt: now, updatedAt: now, sourceCount: 0, tableCount: 0 };
    fs.mkdirSync(this.dirOf(id), { recursive: true });
    writeFileAtomic(path.join(this.dirOf(id), DICT_FILE), JSON.stringify({ version: 1, name, dialect: 'generic', tables: [], importErrors: [] }, null, 2));
    idx.projects.push(meta);
    idx.currentId = id;
    this.writeIndex(idx);
    return meta;
  }

  setCurrent(id: string) {
    const idx = this.readIndex();
    if (!idx.projects.some((p) => p.id === id)) throw new Error(`项目不存在: ${id}`);
    idx.currentId = id;
    this.writeIndex(idx);
  }

  rename(id: string, name: string) {
    const idx = this.readIndex();
    const p = idx.projects.find((x) => x.id === id);
    if (!p) throw new Error(`项目不存在: ${id}`);
    p.name = name;
    p.updatedAt = new Date().toISOString();
    this.writeIndex(idx);
  }

  /** 清空：删掉字典与来源，保留项目本身 */
  clear(id: string) {
    const idx = this.readIndex();
    const p = idx.projects.find((x) => x.id === id);
    if (!p) throw new Error(`项目不存在: ${id}`);
    writeFileAtomic(
      path.join(this.dirOf(id), DICT_FILE),
      JSON.stringify({ version: 1, name: p.name, dialect: 'generic', tables: [], importErrors: [], sources: [] }, null, 2),
    );
    p.sourceCount = 0;
    p.tableCount = 0;
    p.updatedAt = new Date().toISOString();
    this.writeIndex(idx);
  }

  remove(id: string) {
    const idx = this.readIndex();
    idx.projects = idx.projects.filter((p) => p.id !== id);
    if (idx.currentId === id) idx.currentId = idx.projects[0]?.id ?? null;
    this.writeIndex(idx);
    fs.rmSync(this.dirOf(id), { recursive: true, force: true });
  }

  load(id: string): DictionaryModel | null {
    const projectDir = this.dirOf(id);
    try {
      const raw = fs.readFileSync(path.join(projectDir, DICT_FILE), 'utf8');
      return JSON.parse(raw) as DictionaryModel;
    } catch {
      return null;
    }
  }

  save(id: string, dict: DictionaryModel) {
    const projectDir = this.dirOf(id);
    const idx = this.readIndex();
    const p = idx.projects.find((x) => x.id === id);
    if (!p) throw new Error(`项目不存在: ${id}`);
    fs.mkdirSync(projectDir, { recursive: true });
    writeFileAtomic(path.join(projectDir, DICT_FILE), JSON.stringify(dict));
    p.tableCount = dict.tables.length;
    p.sourceCount = dict.sources?.length ?? 0;
    p.updatedAt = new Date().toISOString();
    this.writeIndex(idx);
  }

  /** 读项目连接配置（不存在返回空配置） */
  loadConfig(id: string): ProjectConfig {
    try {
      const raw = fs.readFileSync(path.join(this.dirOf(id), CONFIG_FILE), 'utf8');
      return sanitizeConfig(JSON.parse(raw) as ProjectConfig);
    } catch {
      return emptyProjectConfig();
    }
  }

  /** 写项目连接配置（经白名单过滤，凭据不会落地） */
  saveConfig(id: string, cfg: ProjectConfig) {
    fs.mkdirSync(this.dirOf(id), { recursive: true });
    writeFileAtomic(path.join(this.dirOf(id), CONFIG_FILE), JSON.stringify(sanitizeConfig(cfg), null, 2));
  }



  // ---------------- 拉取结果缓存 ----------------
  // 按"来源类型"缓存到项目目录：断网/换机器也能看到上次拉取的结果；
  // meta 里存配置指纹，改了连接就能判断这份缓存已过期（stale）

  cacheDir(id: string): string {
    return path.join(this.dirOf(id), CACHE_DIR);
  }

  /** 保存拉取结果（字典 + meta）；按 configId 分槽 */
  saveCache(id: string, kind: string, dict: DictionaryModel, meta: CacheMeta, configId?: string) {
    const dir = this.cacheDir(id);
    const slot = cacheSlot(kind, configId ?? meta?.configId);
    fs.mkdirSync(dir, { recursive: true });
    writeFileAtomic(path.join(dir, `${slot}.json`), JSON.stringify(dict));
    writeFileAtomic(path.join(dir, `${slot}.meta.json`), JSON.stringify(meta));
  }

  /** 读取上次拉取结果；meta 里带 importedAt / configHash / formIds */
  loadCache(id: string, kind: string, configId?: string): { dict: DictionaryModel; meta: CacheMeta } | null {
    try {
      const dir = this.cacheDir(id);
      const slot = cacheSlot(kind, configId);
      const dict = JSON.parse(fs.readFileSync(path.join(dir, `${slot}.json`), 'utf8'));
      const meta = JSON.parse(fs.readFileSync(path.join(dir, `${slot}.meta.json`), 'utf8'));
      return { dict, meta };
    } catch { return null; }
  }

  clearCache(id: string, kind?: string, configId?: string) {
    try {
      const dir = this.cacheDir(id);
      if (kind) {
        const slot = cacheSlot(kind, configId);
        fs.rmSync(path.join(dir, `${slot}.json`), { force: true });
        fs.rmSync(path.join(dir, `${slot}.meta.json`), { force: true });
        return;
      }
      fs.rmSync(dir, { recursive: true, force: true });
    } catch { /* 忽略：清缓存失败不影响主流程 */ }
  }

  exportBundle(id: string): ProjectBundle {
    const idx = this.readIndex();
    const p = idx.projects.find((x) => x.id === id);
    if (!p) throw new Error(`项目不存在: ${id}`);
    const dict = this.load(id) ?? { version: 1, name: p.name, dialect: 'generic', tables: [], importErrors: [] };
    return { format: 'dev-toolbox-project', formatVersion: 1, exportedAt: new Date().toISOString(), project: p, dict, config: this.loadConfig(id) };
  }

  /** 导入项目包：总是新建项目，避免覆盖已有同名项目 */
  importBundle(bundle: ProjectBundle): ProjectMeta {
    if (bundle?.format !== 'dev-toolbox-project') throw new Error('不是有效的项目包（.dtproj.json）');
    const meta = this.create(bundle.project?.name || '导入的项目');
    writeFileAtomic(path.join(this.dirOf(meta.id), DICT_FILE), JSON.stringify(bundle.dict ?? { version: 1, name: meta.name, dialect: 'generic', tables: [], importErrors: [] }));
    const idx = this.readIndex();
    this.saveConfig(meta.id, bundle.config ?? emptyProjectConfig());
    const p = idx.projects.find((x) => x.id === meta.id)!;
    p.tableCount = bundle.dict?.tables?.length ?? 0;
    p.sourceCount = bundle.dict?.sources?.length ?? 0;
    idx.currentId = meta.id;
    this.writeIndex(idx);
    return meta;
  }
}
