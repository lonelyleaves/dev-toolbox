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
import { ProjectMeta } from '../core/messaging';

export type { ProjectMeta };

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
}

const INDEX_FILE = 'index.json';
const DICT_FILE = 'dict.json';

export class ProjectStore {
  private readonly root: string;

  constructor(storageUri: vscode.Uri) {
    this.root = path.join(storageUri.fsPath, 'projects');
    fs.mkdirSync(this.root, { recursive: true });
  }

  private get indexPath(): string { return path.join(this.root, INDEX_FILE); }
  private dirOf(id: string): string { return path.join(this.root, id); }

  private readIndex(): ProjectIndex {
    try {
      const raw = fs.readFileSync(this.indexPath, 'utf8');
      const idx = JSON.parse(raw) as ProjectIndex;
      return { version: 1, currentId: idx.currentId ?? null, projects: idx.projects ?? [] };
    } catch {
      return { version: 1, currentId: null, projects: [] };
    }
  }

  private writeIndex(idx: ProjectIndex) {
    fs.mkdirSync(this.root, { recursive: true });
    fs.writeFileSync(this.indexPath, JSON.stringify(idx, null, 2), 'utf8');
  }

  list(): { currentId: string | null; projects: ProjectMeta[] } {
    const idx = this.readIndex();
    return { currentId: idx.currentId, projects: idx.projects };
  }

  create(name: string): ProjectMeta {
    const idx = this.readIndex();
    const id = `p_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
    const now = new Date().toISOString();
    const meta: ProjectMeta = { id, name, createdAt: now, updatedAt: now, sourceCount: 0, tableCount: 0 };
    fs.mkdirSync(this.dirOf(id), { recursive: true });
    fs.writeFileSync(path.join(this.dirOf(id), DICT_FILE), JSON.stringify({ version: 1, name, dialect: 'generic', tables: [], importErrors: [] }, null, 2), 'utf8');
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
    fs.writeFileSync(
      path.join(this.dirOf(id), DICT_FILE),
      JSON.stringify({ version: 1, name: p.name, dialect: 'generic', tables: [], importErrors: [], sources: [] }, null, 2),
      'utf8',
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
    try {
      const raw = fs.readFileSync(path.join(this.dirOf(id), DICT_FILE), 'utf8');
      return JSON.parse(raw) as DictionaryModel;
    } catch {
      return null;
    }
  }

  save(id: string, dict: DictionaryModel) {
    const idx = this.readIndex();
    const p = idx.projects.find((x) => x.id === id);
    fs.mkdirSync(this.dirOf(id), { recursive: true });
    fs.writeFileSync(path.join(this.dirOf(id), DICT_FILE), JSON.stringify(dict), 'utf8');
    if (p) {
      p.tableCount = dict.tables.length;
      p.sourceCount = dict.sources?.length ?? 0;
      p.updatedAt = new Date().toISOString();
      this.writeIndex(idx);
    }
  }

  exportBundle(id: string): ProjectBundle {
    const idx = this.readIndex();
    const p = idx.projects.find((x) => x.id === id);
    if (!p) throw new Error(`项目不存在: ${id}`);
    const dict = this.load(id) ?? { version: 1, name: p.name, dialect: 'generic', tables: [], importErrors: [] };
    return { format: 'dev-toolbox-project', formatVersion: 1, exportedAt: new Date().toISOString(), project: p, dict };
  }

  /** 导入项目包：总是新建项目，避免覆盖已有同名项目 */
  importBundle(bundle: ProjectBundle): ProjectMeta {
    if (bundle?.format !== 'dev-toolbox-project') throw new Error('不是有效的项目包（.dtproj.json）');
    const meta = this.create(bundle.project?.name || '导入的项目');
    fs.writeFileSync(path.join(this.dirOf(meta.id), DICT_FILE), JSON.stringify(bundle.dict ?? { version: 1, name: meta.name, dialect: 'generic', tables: [], importErrors: [] }), 'utf8');
    const idx = this.readIndex();
    const p = idx.projects.find((x) => x.id === meta.id)!;
    p.tableCount = bundle.dict?.tables?.length ?? 0;
    p.sourceCount = bundle.dict?.sources?.length ?? 0;
    idx.currentId = meta.id;
    this.writeIndex(idx);
    return meta;
  }
}
