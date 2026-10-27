import { h } from 'preact';
import { useState, useMemo, useEffect } from 'preact/hooks';
import * as XLSX from 'xlsx';
import { DictionaryModel, TableDef, ColumnDef, emptyDictionary, PARSER_VERSION, migrateDict, makeSourceId, DictSource, SourceKind } from '../../dictionary/model';
import { mergeDictionaries, applyResolutions, defaultResolutions, removeSource, MergeConflict, MergeStats } from '../../dictionary/merge';
import { ProjectBar, SourcesPanel, MergePanel, KingdeePanel, ProjectConfigPanel, TableList, CrossProjectDiffPanel } from './dictionary/panels';
import { parsePdm } from '../../dictionary/pdm';
import { parseDdl } from '../../dictionary/ddl';
import { parseMarkdownDict } from '../../dictionary/markdown';
import { emptyProjectConfig, type ProjectConfig } from '../../core/messaging';
import { diffDictionaries, generateFixSql, mergeBaseIntoTarget, diffReportMarkdown, DiffItem } from '../../dictionary/diffengine';
import { lintDictionary, applyFixes, suggestComments, acceptSuggestions, Violation, NamingRules } from '../../dictionary/naming';
import { exportMarkdown, exportHtml, exportMermaid, exportDdl, exportWordHtml, buildExcelSheets, dictStats, dictSearch, referrersOf } from '../../dictionary/exporters';
import { Btn, CopyBtn, Section } from '../components';
import { host } from '../bridge';
import { DbConnInfo, ProjectMeta } from '../../core/messaging';

const CLIENT_DEFAULT_PORTS: Record<DbConnInfo['client'], number> = { mysql: 3306, postgres: 5432, mssql: 1433, oracle: 1521 };
const CLIENT_LABELS: Record<DbConnInfo['client'], string> = { mysql: 'MySQL', postgres: 'PostgreSQL', mssql: 'SQL Server', oracle: 'Oracle' };
const DB_PLACEHOLDER: Record<DbConnInfo['client'], string> = { mysql: 'database', postgres: 'database', mssql: 'database', oracle: '服务名 Service Name' };
/** 构造一个来源记录（文件路径用于日后按原路径自动重解析） */
function mkSource(kind: SourceKind, name: string, path?: string, tableCount = 0): DictSource {
  return {
    id: makeSourceId(kind), kind, name, path,
    importedAt: new Date().toISOString(),
    parserVersion: PARSER_VERSION,
    tableCount, enabled: true,
    priority: kind === 'pdm' ? 10 : 20, // PDM 优先，DB/金蝶补充
  };
}

/** ER 图最多渲染的表数（每表含列文本，过多会卡） */
const ER_RENDER_CAP = 60;

function ClientPicker({ info, onChange }: { info: DbConnInfo; onChange: (i: DbConnInfo) => void }) {
  return (
    <select value={info.client} onInput={(e) => {
      const client = (e.target as HTMLSelectElement).value as DbConnInfo['client'];
      onChange({ ...info, client, port: CLIENT_DEFAULT_PORTS[client] });
    }}>
      {(Object.keys(CLIENT_LABELS) as DbConnInfo['client'][]).map((c) => <option value={c}>{CLIENT_LABELS[c]}</option>)}
    </select>
  );
}

/**
 * 显示名兜底：与物理名相同、或以「物理名(…)」「物理名（…）」开头时视为重复，不再展示，
 * 避免左侧列表出现 "T_BD_STAFF_L — T_BD_STAFF_L(员工多语言表)" 这种同一个名字显示两次。
 */
function shownName(phys: string, code?: string): string | undefined {
  const c = (code || '').trim();
  if (!c) return undefined;
  const p = (phys || '').trim().toLowerCase();
  if (!p) return c;
  const lc = c.toLowerCase();
  if (lc === p || lc.startsWith(`${p}(`) || lc.startsWith(`${p}（`)) return undefined;
  return c;
}

type Tab = 'browse' | 'edit' | 'lint' | 'repair' | 'export' | 'er' | 'views' | 'procs' | 'seqs' | 'domains' | 'sources' | 'extend' | 'config' | 'xdiff';
const TAB_ORDER: Tab[] = ['browse', 'edit', 'lint', 'repair', 'xdiff', 'export', 'er', 'views', 'procs', 'seqs', 'domains', 'sources', 'extend', 'config'];
const TAB_LABEL: Record<Tab, string> = {
  browse: '浏览', edit: '扩展编辑', lint: '规范检查', repair: '比对修复', xdiff: '跨项目比对', export: '导出',
  er: 'ER 图', views: '视图', procs: '存储过程', seqs: '序列', domains: '域', sources: '来源', extend: '扩展字段', config: '连接配置',
};
const TAB_TITLE: Record<Tab, string> = {
  browse: '浏览表结构和字段详情', edit: '扩展编辑：增删改表/字段/注释', lint: '规范检查：命名规则、注释缺失扫描',
  repair: '比对修复：字典与真实库差异对比',
  xdiff: '跨项目比对：拿当前项目字典和另一个项目逐表逐字段对比',
  export: '导出为 Markdown/HTML/Word/Excel/DDL', er: 'ER 关系图',
  config: '连接配置 · 本项目的数据库连接与金蝶连接',
  views: '视图列表', procs: '存储过程/函数', seqs: '序列列表', domains: '域定义',
  sources: '来源管理：查看/刷新/禁用/移除各导入来源',
  extend: '扩展字段：在线库反向导入 + 金蝶云星空（WebAPI / 表单元数据）',
};

/** 跨项目比对结果 → Markdown 摘要（用于复制给同事/贴工单） */
function diffMarkdown(r: any): string {
  const s = r?.summary;
  if (!s) return '（尚无比对结果）';
  const lines = [
    '# 跨项目字典比对',
    '',
    `- 仅当前项目有：${s.onlyCurrent ?? s.removed}`,
    `- 仅对方项目有：${s.onlyOther ?? s.added}`,
    `- 两边都有但有差异：${s.modified}`,
    '',
    '| 表 | 对象 | 类型 | 变化 |',
    '| --- | --- | --- | --- |',
  ];
  for (const it of (r.items || []).slice(0, 200)) {
    const ch = (it.changes || []).map((c: any) => `${c.prop}: ${c.from} → ${c.to}`).join('；');
    lines.push(`| ${it.table} | ${it.object || ''} | ${it.kind} | ${ch} |`);
  }
  return lines.join('\n');
}

export function DictionaryPage({ setFill }: { prefill?: any; setFill?: (v: boolean) => void } = {}) {
  const [dict, setDict] = useState<DictionaryModel | null>(null);
  const [tab, setTab] = useState<Tab>('browse');
  const [selected, setSelected] = useState('');
  const [kwInput, setKwInput] = useState('');
  const [keyword, setKeyword] = useState('');
  const [naming, setNaming] = useState<NamingRules>({ requireComment: true, requirePrimaryKey: true, forbiddenTypes: ['TEXT', 'BLOB'] });
  const [dbSnap, setDbSnap] = useState<DictionaryModel | null>(null);
  const [projects, setProjects] = useState<ProjectMeta[]>([]);
  const [currentId, setCurrentId] = useState<string | null>(null);
  const [projectConfig, setProjectConfig] = useState<ProjectConfig>(emptyProjectConfig());
  const [secretKeys, setSecretKeys] = useState<string[]>([]);
  const [dbSecretKeys, setDbSecretKeys] = useState<string[]>([]);
  const [configDefaults, setConfigDefaults] = useState<any>({});
  const [cacheMeta, setCacheMeta] = useState<any>({});
  const [diffOther, setDiffOther] = useState('');
  const [diffResult, setDiffResult] = useState<any>(null);
  const [diffBusy, setDiffBusy] = useState(false);
  const [configHash, setConfigHash] = useState<any>({});
  /** 待处理的合并冲突：导入产生差异时先给用户过一遍，再落库 */
  const [pending, setPending] = useState<{
    merged: DictionaryModel;
    conflicts: MergeConflict[];
    resolutions: Record<string, 'base' | 'incoming'>;
    stats: MergeStats;
    sourceName: string;
    /** 本次合并来自「同步」时，记录要回写缓存的来源类型/结果/指纹 */
    sync?: { kind: 'db' | 'kingdee'; dict: DictionaryModel; meta?: any };
  } | null>(null);


  // 搜索防抖：每次按键都全量扫描「表 × 字段」，1 万张表会明显卡顿，
  // 所以输入框只改 kwInput，200ms 后才同步到真正参与过滤的 keyword
  useEffect(() => {
    const t = setTimeout(() => setKeyword(kwInput), 200);
    return () => clearTimeout(t);
  }, [kwInput]);
  /** 载入（或迁移出）当前项目的字典 */
  const loadProject = async (id: string | null, list?: ProjectMeta[]) => {
    // 切项目前先清空上一个项目的运行时状态：在线库快照、未确认的冲突、连接配置与凭据摘要
    setDbSnap(null);
    setPending(null);
    setConfigHash({});
    if (!id) { setDict(null); setProjectConfig(emptyProjectConfig()); setSecretKeys([]); setDbSecretKeys([]); setCacheMeta({}); return; }
    // 连接配置跟着项目走：切换项目时一起换掉（凭据按项目隔离，这里只拿到"有哪些凭据"）
    try {
      const r = await host.projectGetConfig(id);
      setProjectConfig(r?.config ?? emptyProjectConfig());
      setConfigDefaults(r?.defaults ?? {});
      setConfigHash(r?.hash ?? {});
    } catch { setProjectConfig(emptyProjectConfig()); }
    try { setSecretKeys(await host.projectReadSecretExists(id, 'kingdee')); } catch { setSecretKeys([]); }
    // 数据库凭据与金蝶凭据分开查，否则"密码已保存"永远显示未保存
    try { setDbSecretKeys(await host.projectReadSecretExists(id, 'db')); } catch { setDbSecretKeys([]); }
    try { setCacheMeta(await host.projectCacheMeta(id)); } catch { /* 忽略 */ }
    const d = await host.projectLoad(id);
    if (d && Array.isArray(d.tables) && d.tables.length > 0) {
      const m = migrateDict(d);
      setDict(m);
      setSelected(m.tables[0]?.name || '');
    } else {
      setDict(null);
    }
  };

  // 启动：读项目库 → 旧版 workspaceState 字典自动迁移成项目 → 载入当前项目
  useEffect(() => {
    host.getSettings().then((s: any) => s?.naming && setNaming(s.naming)).catch(() => undefined);
    (async () => {
      try {
        let list = await host.projectList();
        if (list.projects.length === 0) {
          // 迁移：旧版本把字典存在 workspaceState，这里原地升级成"默认项目"，不让用户重新选文件
          const old = await host.readState<DictionaryModel>('dict:last').catch(() => null);
          if (old && Array.isArray(old.tables) && old.tables.length > 0) {
            const p = await host.projectCreate(old.name || '默认项目');
            await host.projectSave(p.id, migrateDict(old));
            list = await host.projectList();
            host.showMessage('info', `已把旧版字典迁移为项目「${p.name}」，以后跨工作区也能直接用`).catch(() => undefined);
          }
        }
        setProjects(list.projects);
        const id = list.currentId ?? list.projects[0]?.id ?? null;
        setCurrentId(id);
        await loadProject(id);
      } catch {
        // 项目库不可用（老内核等）时退回旧的 workspaceState 恢复逻辑
        const d = await host.readState<DictionaryModel>('dict:last').catch(() => null);
        if (d && Array.isArray(d.tables) && d.tables.length > 0) {
          const m = migrateDict(d);
          setDict(m);
          setSelected(m.tables[0]?.name || '');
        }
      }
    })();
  }, []);

  const refreshProjects = async (switchTo?: string) => {
    const list = await host.projectList();
    setProjects(list.projects);
    const id = switchTo ?? list.currentId ?? list.projects[0]?.id ?? null;
    setCurrentId(id);
    return id;
  };

  // 字典变化时持久化到项目文件（防抖 500ms；无项目时退回 workspaceState）
  useEffect(() => {
    if (!dict) return;
    const timer = setTimeout(() => {
      // 写盘失败必须让用户知道：静默退回 workspaceState 会导致换工作区就丢数据
      if (currentId) {
        host
          .projectSave(currentId, dict)
          .catch((e: any) => {
            host.showMessage('error', `字典保存到项目失败：${e?.message || e}\n已临时存入工作区状态，建议立即「导出项目包」备份`).catch(() => undefined);
            host.persistState('dict:last', dict).catch(() => undefined);
          });
      }
      else host.persistState('dict:last', dict).catch(() => undefined);
    }, 500);
    return () => clearTimeout(timer);
  }, [dict, currentId]);

  // 双栏视图需要页面自身不滚动（左右两栏各自滚）。这里显式通知外层，
  // 不用 CSS :has —— 部分二开内核不支持，会导致"左栏滚不动、整页在滚"
  useEffect(() => {
    setFill?.(!!dict && tab === 'browse');
    return () => setFill?.(false);
  }, [tab, dict]);

  // ---------- 导入（多来源合并） ----------
  /**
   * 把一次解析结果作为"来源"并入当前字典；有冲突则先弹冲突面板。
   * projectId/base 两个入参必须显式传：state 更新是异步的，
   * 靠闭包里的 currentId/dict 会拿到旧值（建项目后立即递归 → 无限建项目）。
   */
  /** 保存字典到项目：失败必须让用户知道（静默失败 = 换工作区才发现数据没了） */
  const saveOrWarn = (id: string, d: DictionaryModel) => {
    host
      .projectSave(id, d)
      .catch((e: any) => {
        host
          .showMessage('error', `保存到项目失败：${e?.message || e}\n请立即「导出项目包」备份，避免丢失`)
          .catch(() => undefined);
      });
  };

  const applyImport = (
    d: DictionaryModel,
    source: DictSource,
    opts?: { projectId?: string | null; base?: DictionaryModel | null; sync?: { kind: 'db' | 'kingdee'; dict: DictionaryModel; meta?: any } },
  ): boolean => {
    const id = opts?.projectId !== undefined ? opts.projectId : currentId;
    const base = opts?.base !== undefined ? opts.base : dict;
    if (!id) {
      // 没有项目时先建一个，避免数据无处可存
      host.projectCreate(d.name || source.name || '默认项目').then(async (p) => {
        await refreshProjects(p.id);
        applyImport(d, source, { projectId: p.id, base, sync: opts?.sync });
      }).catch(() => undefined);
      return false;
    }
    if (d.tables.length === 0) {
      host.showMessage('error', `导入失败：未解析到任何表。${d.importErrors[0]?.message || '文件格式可能不受支持'}`).catch(() => undefined);
      return false;
    }
    d.meta = { ...d.meta, importedAt: new Date().toISOString(), parser: PARSER_VERSION, source: source.name, sourcePath: source.path };
    if (!base || base.tables.length === 0) {
      const m = migrateDict({ ...d, sources: [source] });
      setDict(m);
      setSelected(m.tables[0]?.name || '');
      setTab('browse');
      saveOrWarn(id, m);
      host.showMessage('info', `导入完成：${m.tables.length} 张表`).catch(() => undefined);
      return false;
    }
    const r = mergeDictionaries(base, d, source);
    if (r.conflicts.length > 0) {
      setPending({
        merged: r.dict,
        conflicts: r.conflicts,
        resolutions: defaultResolutions(r.conflicts, 'base'),
        stats: r.stats,
        sourceName: source.name,
      });
      return true;
    }
    const m = migrateDict(r.dict);
    setDict(m);
    setTab('browse');
    saveOrWarn(id, m);
    host.showMessage('info', `合并完成：新增 ${r.stats.tablesAdded} 表 / ${r.stats.columnsAdded} 字段，共 ${m.tables.length} 张表`).catch(() => undefined);
    return false;
  };

  /** 冲突面板点"应用"：按用户选择落地 */
  const applyPending = () => {
    if (!pending || !currentId) return;
    const finalDict = migrateDict(applyResolutions(pending.merged, pending.conflicts, pending.resolutions));
    setDict(finalDict);
    setPending(null);
    setTab('browse');
    saveOrWarn(currentId, finalDict);
    // 同步流程：只有确认合并成功才写缓存，取消则不写（否则缓存与字典会不一致）
    if (pending.sync) {
      host
        .projectSaveCache(currentId, pending.sync.kind, pending.sync.dict, pending.sync.meta)
        .then(async () => { try { setCacheMeta(await host.projectCacheMeta(currentId)); } catch { /* 忽略 */ } })
        .catch(() => undefined);
    }
    host.showMessage('info', `已应用 ${pending.conflicts.length} 项冲突决议`).catch(() => undefined);
  };

  /** 移除来源：连带删除该来源带来的表与字段 */
  const removeSourceById = async (id: string) => {
    if (!dict || !currentId) return;
    const out = removeSource(dict, id);
    const m = migrateDict(out.dict);
    setDict(m.tables.length ? m : null);
    await host.projectSave(currentId, m);
    await refreshProjects();
    host.showMessage('info', `已移除来源：删除 ${out.removedTables} 张表、${out.removedColumns} 个字段`).catch(() => undefined);
  };

  /** 按原路径重新解析某个来源（先撤回它原有的贡献，再重新合并） */
  const refreshSource = async (id: string) => {
    const s = (dict?.sources || []).find((x) => x.id === id);
    if (!s || !s.path || !dict) return;
    const r = await host.readTextFileAt(s.path);
    if (!r.ok || typeof r.content !== 'string') {
      host.showMessage('warn', `无法读取 ${s.path}，请确认文件还在`).catch(() => undefined);
      return;
    }
    const ext = (s.path.split('.').pop() || '').toLowerCase();
    let nd: DictionaryModel | null = null;
    try {
      if (ext === 'pdm') nd = parsePdm(r.content);
      else if (ext === 'sql') nd = parseDdl(r.content, /postgres|pg/i.test(s.path) ? 'postgres' : 'mysql');
      else if (ext === 'md') nd = parseMarkdownDict(r.content);
    } catch { nd = null; }
    if (!nd || nd.tables.length === 0) {
      host.showMessage('warn', '重新解析未得到表，来源保持不变').catch(() => undefined);
      return;
    }
    // 先撤回该来源原有的贡献（字段被删掉的话要真的消失），再把重新解析的结果并回去
    const stripped = removeSource(dict, s.id);
    applyImport(
      nd,
      { ...s, importedAt: new Date().toISOString(), parserVersion: PARSER_VERSION, tableCount: nd.tables.length },
      { projectId: currentId, base: stripped.dict },
    );
    host.showMessage('info', `已重新解析来源「${s.name}」`).catch(() => undefined);
  };

  const toggleSource = async (id: string) => {
    if (!dict || !currentId) return;
    const m: DictionaryModel = { ...dict, sources: (dict.sources || []).map((s) => (s.id === id ? { ...s, enabled: !s.enabled } : s)) };
    setDict(m);
    await host.projectSave(currentId, m);
  };

  /** 通用导入：按扩展名自动选择解析器（来源面板/工具栏的"导入新来源"用它） */
  const importAny = async () => {
    const f = await host.openTextFile();
    if (!f) return;
    const ext = (f.name.split('.').pop() || '').toLowerCase();
    if (ext === 'pdm') return importPdmWith(f);
    if (ext === 'sql') return importDdlWith(f);
    if (ext === 'md') return importMdWith(f);
    if (ext === 'json') return importDtcatWith(f);
    host.showMessage('warn', `暂不支持的文件类型 .${ext}（支持 pdm / sql / md / json）`).catch(() => undefined);
  };

  const importPdmWith = async (f: { name: string; path?: string; content: string }) => {
    const d = parsePdm(f.content);
    d.name = f.name.replace(/\.pdm$/i, '');
    applyImport(d, mkSource('pdm', f.name, f.path, d.tables.length));
  };
  const importDdlWith = async (f: { name: string; path?: string; content: string }) => {
    const d = parseDdl(f.content, /postgres|pg/i.test(f.name) ? 'postgres' : 'mysql');
    d.name = f.name.replace(/\.sql$/i, '');
    applyImport(d, mkSource('ddl', f.name, f.path, d.tables.length));
  };
  const importMdWith = async (f: { name: string; path?: string; content: string }) => {
    const d = parseMarkdownDict(f.content);
    d.name = f.name.replace(/\.md$/i, '');
    applyImport(d, mkSource('md', f.name, f.path, d.tables.length));
  };
  const importDtcatWith = async (f: { name: string; path?: string; content: string }) => {
    try {
      const d = JSON.parse(f.content) as DictionaryModel;
      if (d.version !== 1 || !Array.isArray(d.tables)) throw new Error('不是有效的 .dtcat.json');
      applyImport(d, mkSource('dtcat', f.name, f.path, d.tables.length));
    } catch (e: any) {
      host.showMessage('error', `加载失败: ${e?.message || e}`);
    }
  };
  /** 「同步」：用本项目的连接重新拉取 → 撤掉旧来源贡献 → 按新结果合并（差异走冲突面板由你确认） */
  const syncSource = async (id: string, kind: 'db' | 'kingdee') => {
    if (!currentId) return;
    try {
      const r = await host.projectSync(currentId, kind);
      if (!r?.ok || !r.dict) { alert(`同步失败：${r?.error || '未知错误'}`); return; }
      const s = (dict?.sources || []).find((x) => x.id === id);
      const stripped = dict ? removeSource(dict, id).dict : null;
      const deferred = applyImport(r.dict, {
        id,
        kind,
        name: s?.name || (kind === 'db' ? '在线库' : '金蝶元数据'),
        priority: s?.priority ?? (kind === 'db' ? 20 : 20),
        enabled: true,
        importedAt: r.meta?.importedAt || new Date().toISOString(),
        tableCount: r.dict.tables.length,
      }, { projectId: currentId, base: stripped, sync: { kind, dict: r.dict, meta: r.meta } });
      // 无冲突时上面已直接落地，这里补写缓存；有冲突则交给冲突面板确认后再写
      if (!deferred) {
        await host.projectSaveCache(currentId, kind, r.dict, r.meta).catch(() => undefined);
      }
      setCacheMeta(await host.projectCacheMeta(currentId));
    } catch (e: any) {
      alert(`同步失败：${e?.message || e}`);
    }
  };

  /** 跨项目比对：当前项目字典 vs 另一个项目的字典 */
  const runCrossDiff = async () => {
    if (!currentId || !diffOther) return;
    setDiffBusy(true);
    try {
      const r = await host.projectDiff(currentId, diffOther);
      if (!r?.ok) { alert(`比对失败：${r?.error || '未知错误'}`); return; }
      setDiffResult(r);
    } catch (e: any) {
      alert(`比对失败：${e?.message || e}`);
    } finally {
      setDiffBusy(false);
    }
  };

  /** 连接配置页的「测试连接 / 测试 WebAPI 配置」：先落盘再测，避免测的是没保存的参数 */
  const testConn = async (kind: 'db' | 'kingdee', cfg: ProjectConfig, secrets: any): Promise<string> => {
    if (!currentId) return '未选中项目';
    try {
      await host.projectSaveConfig(currentId, cfg);
      if (secrets?.dbPassword) await host.projectSaveSecret(currentId, 'db', { password: secrets.dbPassword });
      const kv: Record<string, string> = {};
      if (secrets?.appSecret) kv.appSecret = secrets.appSecret;
      if (secrets?.password) kv.password = secrets.password;
      if (Object.keys(kv).length) await host.projectSaveSecret(currentId, 'kingdee', kv);
      // 测试连接也会顺带保存凭据，刷新"已保存/未保存"标记
      setSecretKeys(await host.projectReadSecretExists(currentId, 'kingdee'));
      setDbSecretKeys(await host.projectReadSecretExists(currentId, 'db'));
      setProjectConfig(cfg);
      if (kind === 'db') {
        return await host.dbTestConnection({ ...(cfg.connections?.db || {}), password: secrets?.dbPassword || '', projectId: currentId } as any);
      }
      const r = await host.kingdeeTestConfig(currentId);
      return r.ok ? r.message : `✗ ${r.message}`;
    } catch (e: any) {
      return `✗ ${e?.message || e}`;
    }
  };

  const importPdm = async () => { const f = await host.openTextFile(); if (f) await importPdmWith(f); };
  const importDdl = async () => { const f = await host.openTextFile(); if (f) await importDdlWith(f); };
  const importMd = async () => { const f = await host.openTextFile(); if (f) await importMdWith(f); };
  const importExcel = async () => {
    const f = await host.openBinaryFile();
    if (!f) return;
    const wb = XLSX.read(f.base64, { type: 'base64' });
    const d = emptyDictionary(f.name.replace(/\.(xlsx|xls)$/i, ''), 'generic');
    for (const sheetName of wb.SheetNames) {
      if (sheetName === '总览' || sheetName === 'overview') continue;
      const rows: string[][] = XLSX.utils.sheet_to_json(wb.Sheets[sheetName], { header: 1, defval: '' }) as any;
      if (rows.length < 2) continue;
      const header = rows[0].map((x) => String(x).toLowerCase());
      const colIdx = header.findIndex((x) => /字段|field|column|name/.test(x));
      const typeIdx = header.findIndex((x) => /类型|type/.test(x));
      const cmtIdx = header.findIndex((x) => /注释|说明|comment/.test(x));
      const pkIdx = header.findIndex((x) => /主键|pk/.test(x));
      if (colIdx < 0) continue;
      const table: TableDef = { name: sheetName, columns: [], indexes: [], foreignKeys: [] };
      for (const r of rows.slice(1)) {
        const name = String(r[colIdx] || '').trim();
        if (!name) continue;
        table.columns.push({
          name, type: typeIdx >= 0 ? String(r[typeIdx] || 'varchar').trim() : 'varchar',
          comment: cmtIdx >= 0 ? String(r[cmtIdx] || '').trim() || undefined : undefined,
          pk: pkIdx >= 0 ? ['YES', 'Y', '是', '√', '1'].includes(String(r[pkIdx]).trim().toUpperCase()) : false,
        });
      }
      if (table.columns.length) d.tables.push(table);
    }
    if (d.tables.length === 0) d.importErrors.push({ source: 'excel', message: '未识别到有效 sheet（要求首行为 字段/类型/注释 表头）' });
    applyImport(d, mkSource('excel', f.name, undefined, d.tables.length));
  };
  const importDtcat = async () => { const f = await host.openTextFile(); if (f) await importDtcatWith(f); };
  const saveDtcat = async () => {
    if (!dict) return;
    await host.saveTextFile(`${dict.name || 'dictionary'}.dtcat.json`, JSON.stringify(dict, null, 2));
  };

  /** DB 反向导入 / 金蝶接入等非文件来源的统一入口 */
  const finishImport = (d: DictionaryModel, name: string, kind: SourceKind = 'db') => {
    applyImport(d, mkSource(kind, name || d.name || kind, undefined, d.tables.length));
  };

  // ---------- 渲染 ----------
  // 连接配置面板：提取出来复用——空字典时（新建项目后）也要能进配置页
  const configPane = (
    <Section title="连接配置">
      {currentId ? (
        <ProjectConfigPanel
          projectName={projects.find((x) => x.id === currentId)?.name || '当前项目'}
          config={projectConfig}
          savedSecretKeys={secretKeys}
          savedDbKeys={dbSecretKeys}
          defaults={configDefaults}
          onTest={testConn}
          onSave={async (cfg, secrets) => {
            await host.projectSaveConfig(currentId, cfg);
            if (secrets.dbPassword) await host.projectSaveSecret(currentId, 'db', { password: secrets.dbPassword });
            const kv: Record<string, string> = {};
            if (secrets.appSecret) kv.appSecret = secrets.appSecret;
            if (secrets.password) kv.password = secrets.password;
            if (Object.keys(kv).length) await host.projectSaveSecret(currentId, 'kingdee', kv);
            setProjectConfig(cfg);
            setSecretKeys(await host.projectReadSecretExists(currentId, 'kingdee'));
            setDbSecretKeys(await host.projectReadSecretExists(currentId, 'db'));
          }}
        />
      ) : (
        <div class="small muted">
          当前没有项目。请先在上方新建一个项目（或导入项目包），选中后再配置数据库连接与金蝶连接。
        </div>
      )}
    </Section>
  );

  if (!dict) {
    return (
      <div>
        <ProjectBar
          projects={projects}
          currentId={currentId}
          onSwitch={async (id) => { await host.projectSwitch(id); const nid = await refreshProjects(id); await loadProject(nid); }}
          onCreate={async (name) => { await host.projectCreate(name); await loadProject(null); await refreshProjects(); }}
          onRename={async (name) => { if (currentId) { await host.projectRename(currentId, name); await refreshProjects(); } }}
          onClear={async () => { if (currentId) { await host.projectClear(currentId); await loadProject(null); await refreshProjects(); } }}
          onDelete={async () => { if (currentId) { await host.projectDelete(currentId); const next = await refreshProjects(); await loadProject(next); } }}
          onExport={() => { if (currentId) host.projectExport(currentId, `${projects.find((p) => p.id === currentId)?.name || 'project'}.dtproj.json`).catch(() => undefined); }}
          onImport={async () => { await host.projectImport(); const id = await refreshProjects(); await loadProject(id); }}
          onConfig={() => setTab('config')}
        />
        <div class="dc-header">
          <div class="toolbar">
            <strong>{projects.find((x) => x.id === currentId)?.name || '（未选择项目）'}</strong>
            <span class="badge">暂无字典，请先导入或拉取</span>
          </div>
          <div class="toolbar dc-tabs">
            {TAB_ORDER.map((t) => (
              <button key={t} class={`btn${tab === t ? ' primary' : ''}`} onClick={() => setTab(t)} title={TAB_TITLE[t]}>
                {TAB_LABEL[t]}
              </button>
            ))}
          </div>
        </div>
        {tab === 'config' ? configPane : (
        <Section title="导入数据字典">
          <div class="toolbar">
            <Btn primary onClick={importPdm}>导入 PDM (PowerDesigner)</Btn>
            <Btn primary onClick={importDdl}>导入 DDL (.sql)</Btn>
            <Btn primary onClick={importMd}>导入 Markdown 字典</Btn>
            <Btn primary onClick={importExcel}>导入 Excel 字典</Btn>
            <Btn onClick={importDtcat}>加载 .dtcat.json</Btn>
          </div>
          <div class="small muted" style="margin-top:8px">
            也可从在线数据库反向导入：
          </div>
          <DbImportForm onImported={(d) => finishImport(d, `${d.name || '数据库'}`, 'db')} />
        </Section>
        )}
      </div>
    );
  }

  const hits = keyword ? dictSearch(dict, keyword) : [];
  const stats = dictStats(dict);
  const table = dict.tables.find((t) => t.name === selected) || dict.tables[0];

  /** 外键/被引用跳转：切到浏览页并选中目标表（大小写不敏感） */
  const jumpTo = (name: string) => {
    const target = dict.tables.find((t) => t.name.toLowerCase() === name.toLowerCase());
    if (!target) {
      host.showMessage('warn', `字典中不存在表 ${name}，无法跳转`);
      return;
    }
    setSelected(target.name);
    setKwInput('');
    setTab('browse');
  };

  // 有待处理的合并冲突时优先展示冲突面板
  if (pending) {
    return (
      <div>
        <MergePanel
          conflicts={pending.conflicts}
          resolutions={pending.resolutions}
          setResolutions={(r) => setPending({ ...pending, resolutions: r })}
          sourceName={pending.sourceName}
          stats={pending.stats}
          onApply={applyPending}
          onCancel={() => { setPending(null); host.showMessage('info', '已取消本次导入，字典未改动').catch(() => undefined); }}
        />
      </div>
    );
  }

  return (
    <div>
      <ProjectBar
        projects={projects}
        currentId={currentId}
        onSwitch={async (id) => { await host.projectSwitch(id); const nid = await refreshProjects(id); await loadProject(nid); }}
        onCreate={async (name) => { const p = await host.projectCreate(name); await loadProject(null); await refreshProjects(p.id); }}
        onRename={async (name) => { if (currentId) { await host.projectRename(currentId, name); await refreshProjects(); } }}
        onClear={async () => { if (currentId) { await host.projectClear(currentId); await loadProject(null); await refreshProjects(); } }}
        onDelete={async () => { if (currentId) { await host.projectDelete(currentId); const next = await refreshProjects(); await loadProject(next); } }}
        onExport={() => { if (currentId) host.projectExport(currentId, `${projects.find((p) => p.id === currentId)?.name || 'project'}.dtproj.json`).catch(() => undefined); }}
        onImport={async () => { await host.projectImport(); const id = await refreshProjects(); await loadProject(id); }}
          onConfig={() => setTab('config')}
      />
      <div class="dc-header">
      <div class="toolbar">
        <strong class="mono">{dict.name}</strong>
        <span class="badge">{stats.tables} 表</span>
        <span class="badge">{stats.columns} 列</span>
        <span class={`badge ${stats.commentedColumns / Math.max(stats.columns, 1) > 0.6 ? 'ok' : 'warn'}`}>注释覆盖 {Math.round((stats.commentedColumns / Math.max(stats.columns, 1)) * 100)}%</span>
        {dict.importErrors.length > 0 && <span class="badge warn" title={dict.importErrors.map((e) => `${e.source}: ${e.message}`).join('\n')}>导入警告 {dict.importErrors.length}</span>}
        <span class="grow" />
        <Btn onClick={importPdm} title="导入 PowerDesigner .pdm 文件">PDM</Btn>
        <Btn onClick={importDdl} title="导入 DDL 建表语句 (.sql)">DDL</Btn>
        <Btn onClick={importMd} title="导入 Markdown 格式数据字典">MD</Btn>
        <Btn onClick={importExcel} title="导入 Excel 数据字典 (.xlsx/.xls)">Excel</Btn>
        <Btn onClick={saveDtcat} title="保存为 .dtcat.json 文件（可进 Git 版本管理）">保存 .dtcat.json</Btn>
        <Btn onClick={() => { setDict(null); setDbSnap(null); host.persistState('dict:last', null).catch(() => undefined); }} title="关闭字典并清除缓存">关闭</Btn>
      </div>
      <div class="toolbar dc-tabs">
        {TAB_ORDER.map((t) => (
          <button key={t} class={`btn${tab === t ? ' primary' : ''}`} onClick={() => setTab(t)} title={TAB_TITLE[t]}>
            {TAB_LABEL[t]}
          </button>
        ))}
      </div>
      </div>

      {tab === 'browse' && (
        dict.tables.length === 0 ? (
          <Section title="导入报告">
            {dict.importErrors.length === 0 ? <div class="muted">无表可展示</div> : (
              <ul class="plain small error-text">{dict.importErrors.map((e) => <li>[{e.source}] {e.message}</li>)}</ul>
            )}
          </Section>
        ) : (
        <div class="split">
          <TableList
            dict={dict}
                  tables={dict.tables}
            sources={dict.sources || []}
            selected={selected}
            onSelect={(name) => setSelected(name)}
            keyword={keyword}
            onKeyword={(v) => setKwInput(v)}
          />
          <div class="right">
            {table && <TableDetail dict={dict} table={table} onJump={jumpTo} />}
          </div>
        </div>
        )
      )}

      {tab === 'edit' && table && <EditTable dict={dict} setDict={setDict} table={table} onRename={(newName) => setSelected(newName)} />}
      {tab === 'lint' && <LintPanel dict={dict} setDict={setDict} naming={naming} />}
      {tab === 'repair' && <RepairPanel dict={dict} setDict={setDict} dbSnap={dbSnap} setDbSnap={setDbSnap} preset={projectConfig.connections?.db} projectId={currentId} />}
      {tab === 'xdiff' && (
        <CrossProjectDiffPanel
          projects={projects}
          currentId={currentId || ''}
          otherId={diffOther}
          onPickOther={setDiffOther}
          diff={diffResult || {}}
          loading={diffBusy}
          onRun={runCrossDiff}
          onCopy={async () => {
            await host.copyText(diffMarkdown(diffResult));
            host.showMessage('info', '差异报告已复制到剪贴板').catch(() => undefined);
          }}
        />
      )}

      {tab === 'export' && <ExportPanel dict={dict} />}
      {tab === 'er' && <ErPanel dict={dict} />}
      {tab === 'views' && <ViewsPanel dict={dict} />}
      {tab === 'procs' && <ProcsPanel dict={dict} />}
      {tab === 'seqs' && <SeqsPanel dict={dict} />}
      {tab === 'domains' && <DomainsPanel dict={dict} />}
      {tab === 'sources' && (
        <SourcesPanel
          dict={dict}
          onRemove={removeSourceById}
          onToggle={toggleSource}
          onRefresh={refreshSource}
          onAdd={importAny}
          onSync={syncSource}
          cacheMeta={cacheMeta}
          hash={configHash}
        />
      )}
      {tab === 'config' && configPane}
      {tab === 'extend' && (
        <div>
          <Section title="数据库扩展字段">
            <div class="small muted" style="margin-bottom:6px">
              在已有 PDM 字典上叠加真实库的字段：按表名归一化匹配，库里新增的表/字段会并入，同名差异会弹冲突面板让你选。
            </div>
            <DbImportForm projectId={currentId} preset={projectConfig.connections?.db} onImported={(d) => finishImport(d, `${d.name || '数据库'}`, 'db')} />
          </Section>
          <KingdeePanel projectId={currentId} onImport={(d, name) => finishImport(d, name, 'kingdee')} />
        </div>
      )}
    </div>
  );
}

// ---------- 在线库导入表单 ----------
function DbImportForm({ projectId, preset, onImported }: { projectId?: string | null; preset?: ProjectConfig['connections']['db']; onImported: (d: DictionaryModel) => void }) {
  // 表单初值来自本项目的连接配置；密码不回显，留空则用该项目已保存的密码
  const [info, setInfo] = useState<DbConnInfo>({
    client: preset?.client || 'mysql',
    host: preset?.host || '127.0.0.1',
    port: preset?.port || 3306,
    user: preset?.user || 'root',
    password: '',
    database: preset?.database || '',
  });
  const [busy, setBusy] = useState('');
  const [msg, setMsg] = useState('');

  // 带上 projectId：密码优先从该项目的凭据里取，实现"同一库不同项目不同密码"
  const conn = { ...info, projectId: projectId ?? undefined };

  const test = async () => {
    setBusy('test'); setMsg('');
    try { setMsg(`✓ ${await host.dbTestConnection(conn)}`); } catch (e: any) { setMsg(`✗ ${e?.message || e}`); }
    setBusy('');
  };
  const imp = async () => {
    setBusy('import'); setMsg('');
    try {
      const d = await host.dbIntrospect(conn);
      if (info.password) await host.dbSavePassword({ ...conn, secretKey: undefined }, info.password);
      onImported(d);
    } catch (e: any) { setMsg(`✗ ${e?.message || e}`); }
    setBusy('');
  };

  return (
    <div class="row" style="margin-top:6px">
      <ClientPicker info={info} onChange={setInfo} />
      <input type="text" style="width:130px" placeholder="host" value={info.host} onInput={(e) => setInfo({ ...info, host: (e.target as HTMLInputElement).value })} />
      <input type="number" style="width:64px" value={info.port} onInput={(e) => setInfo({ ...info, port: Number((e.target as HTMLInputElement).value) })} />
      <input type="text" style="width:90px" placeholder="user" value={info.user} onInput={(e) => setInfo({ ...info, user: (e.target as HTMLInputElement).value })} />
      <input type="password" style="width:110px" placeholder="password" value={info.password} onInput={(e) => setInfo({ ...info, password: (e.target as HTMLInputElement).value })} />
      <input type="text" style="width:130px" placeholder={DB_PLACEHOLDER[info.client]} value={info.database} onInput={(e) => setInfo({ ...info, database: (e.target as HTMLInputElement).value })} />
      <Btn onClick={test} disabled={!!busy}>{busy === 'test' ? '测试中…' : '测试连接'}</Btn>
      <Btn primary onClick={imp} disabled={!!busy || !info.database}>{busy === 'import' ? '导入中…' : '反向导入'}</Btn>
      {msg && <span class="small mono">{msg}</span>}
    </div>
  );
}

// ---------- 表详情 ----------
function TableDetail({ dict, table, onJump }: { dict: DictionaryModel; table: TableDef; onJump?: (tableName: string) => void }) {
  const referrers = referrersOf(dict, table.name);
  const subName = shownName(table.name, table.code);
  const sqlTemplate = `SELECT ${table.columns.map((c) => c.name).join(', ')}\nFROM ${table.name}\nLIMIT 100;`;
  return (
    <div>
      <Section title={`${table.name}${subName ? ` (${subName})` : ''}${table.comment && table.comment !== subName ? ' — ' + table.comment : ''}`}>
        {(table.creator || table.modifier) && (
          <div class="small muted" style="margin-bottom:8px">
            {table.creator && <span>创建者: {table.creator}</span>}
            {table.modifier && <span style="margin-left:12px">修改者: {table.modifier}</span>}
          </div>
        )}
        <table class="tbl">
          <thead><tr><th>#</th><th>物理名 (Code)</th><th>显示名 (Name)</th><th>类型</th><th>长度</th><th class="tight" title="必填（NOT NULL）">必填</th><th>键</th><th>默认值</th><th>注释</th></tr></thead>
          <tbody>
            {table.columns.map((c, i) => (
              <tr>
                <td class="muted">{i + 1}</td>
                <td class="mono"><b>{c.name}</b></td>
                <td>{c.code && c.code !== c.name ? c.code : <span class="muted">—</span>}</td>
                <td class="mono">{c.type}</td>
                <td class="mono">{c.length ?? ''}</td>
                <td class="tight">{c.nullable === false ? <span title="NOT NULL">✓</span> : ''}</td>
                <td>{c.pk ? <span class="badge info">PK</span> : ''}</td>
                <td class="mono small">{c.defaultValue ?? ''}</td>
                <td>{c.comment ?? ''}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </Section>
      {table.indexes.length > 0 && (
        <Section title="索引">
          <ul class="plain small mono">{table.indexes.map((x) => <li>{x.name} {x.unique ? 'UNIQUE' : ''} ({x.columns.join(', ')})</li>)}</ul>
        </Section>
      )}
      {table.foreignKeys.length > 0 && (
        <Section title="外键（点击目标表名可跳转）">
          <ul class="plain small mono">{table.foreignKeys.map((f) => (
            <li>{f.name}: ({f.columns.join(', ')}) →{' '}
              {onJump
                ? <a class="link" href="#" onClick={(e) => { e.preventDefault(); onJump(f.refTable); }} title={`跳转到 ${f.refTable}`}>{f.refTable}</a>
                : f.refTable}({f.refColumns.join(', ')})
            </li>
          ))}</ul>
        </Section>
      )}
      {referrers.length > 0 && (
        <Section title="被引用（哪些表外键指向本表，点击可跳转）">
          <ul class="plain small mono">{referrers.map((r) => (
            <li>
              {onJump
                ? <a class="link" href="#" onClick={(e) => { e.preventDefault(); onJump(r.table); }} title={`跳转到 ${r.table}`}>{r.table}</a>
                : r.table}.{r.columns.join(',')} — {r.fk}
            </li>
          ))}</ul>
        </Section>
      )}
      <div class="row">
        <CopyBtn text={() => sqlTemplate} label="复制 SELECT 模板" />
        <CopyBtn text={() => `INSERT INTO ${table.name} (${table.columns.map((c) => c.name).join(', ')}) VALUES (${table.columns.map(() => '?').join(', ')});`} label="复制 INSERT 模板" />
        <CopyBtn text={() => table.columns.map((c) => `  ${c.name} ${c.type}${c.length ? `(${c.length})` : ''}${c.comment ? ` COMMENT '${c.comment}'` : ''}`).join(',\n')} label="复制列定义" />
      </div>
      <details style="margin-top:8px">
        <summary class="small">建表 SQL 预览（按字典方言 {dict.dialect}）</summary>
        <pre class="out mono small">{exportDdl({ ...dict, tables: [table] })}</pre>
      </details>
    </div>
  );
}

// ---------- 扩展编辑 ----------
function EditTable({ dict, setDict, table, onRename }: {
  dict: DictionaryModel; setDict: (d: DictionaryModel) => void; table: TableDef; onRename: (newName: string) => void;
}) {
  // 仅克隆当前表，避免大字典（1000+ 表）每次按键全量深拷贝
  const update = (fn: (t: TableDef) => void) => {
    const clone: TableDef = JSON.parse(JSON.stringify(table));
    fn(clone);
    if (clone.name !== table.name) onRename(clone.name);
    setDict({ ...dict, tables: dict.tables.map((x) => (x.name === table.name ? clone : x)) });
  };
  const tagCell = (c: ColumnDef) => c.changeTag ? <span class={`badge ${c.changeTag}`}>{c.changeTag}</span> : null;

  return (
    <div>
      <Section title={`编辑表：${table.name}`}>
        <div class="row">
          <label class="small">表名</label>
          <input type="text" class="mono" value={table.name} onInput={(e) => update((t) => { t.name = (e.target as HTMLInputElement).value; t.changeTag = 'modified'; })} />
          <label class="small">注释</label>
          <input type="text" style="flex:1" value={table.comment || ''} onInput={(e) => update((t) => { t.comment = (e.target as HTMLInputElement).value; t.changeTag = 'modified'; })} />
        </div>
        <table class="tbl" style="margin-top:8px">
          <thead><tr><th>字段</th><th>类型</th><th>可空</th><th>主键</th><th>注释</th><th>状态</th><th></th></tr></thead>
          <tbody>
            {table.columns.map((c, i) => (
              <tr>
                <td><input type="text" class="mono" style="width:130px" value={c.name} onInput={(e) => update((t) => { t.columns[i].name = (e.target as HTMLInputElement).value; t.columns[i].changeTag = 'modified'; })} /></td>
                <td><input type="text" class="mono" style="width:130px" value={c.type} onInput={(e) => update((t) => { t.columns[i].type = (e.target as HTMLInputElement).value; t.columns[i].changeTag = 'modified'; })} /></td>
                <td><input type="checkbox" checked={c.nullable !== false} onInput={(e) => update((t) => { t.columns[i].nullable = !(e.target as HTMLInputElement).checked; t.columns[i].changeTag = 'modified'; })} /></td>
                <td><input type="checkbox" checked={!!c.pk} onInput={(e) => update((t) => { t.columns[i].pk = (e.target as HTMLInputElement).checked; t.columns[i].changeTag = 'modified'; })} /></td>
                <td><input type="text" style="width:180px" value={c.comment || ''} onInput={(e) => update((t) => { t.columns[i].comment = (e.target as HTMLInputElement).value; t.columns[i].changeTag = 'modified'; })} /></td>
                <td>{tagCell(c)}</td>
                <td><Btn onClick={() => update((t) => t.columns.splice(i, 1))}>删</Btn></td>
              </tr>
            ))}
          </tbody>
        </table>
        <div class="toolbar">
          <Btn primary onClick={() => update((t) => t.columns.push({ name: 'new_column', type: 'varchar(64)', nullable: true, changeTag: 'added' }))}>+ 新增字段</Btn>
          <Btn onClick={() => {
            const next: DictionaryModel = JSON.parse(JSON.stringify(dict));
            next.tables.push({ name: 'new_table', columns: [{ name: 'id', type: 'bigint', pk: true, nullable: false }], indexes: [], foreignKeys: [], changeTag: 'added' });
            setDict(next);
          }}>+ 新增表</Btn>
          <Btn onClick={() => setDict({ ...dict, tables: dict.tables.filter((t) => t.name !== table.name) })}>删除当前表</Btn>
        </div>
        <div class="small muted">变更以三色标记（added/modified/deleted），保存 .dtcat.json 后可进 Git 版本管理</div>
      </Section>
    </div>
  );
}

// ---------- 规范检查 ----------
function LintPanel({ dict, setDict, naming: initialRules }: { dict: DictionaryModel; setDict: (d: DictionaryModel) => void; naming: NamingRules }) {
  const [rules, setRules] = useState<NamingRules>(initialRules);
  const [run, setRun] = useState(0);
  const violations = useMemo(() => (run ? lintDictionary(dict, rules) : []), [dict, rules, run]);
  const suggestions = useMemo(() => (run ? suggestComments(dict) : []), [dict, run]);
  const [accepted, setAccepted] = useState<Record<string, boolean>>({});

  return (
    <div>
      <Section title="规范规则">
        <div class="row">
          <label class="small">表名前缀</label>
          <input type="text" style="width:80px" value={rules.tablePrefix || ''} onInput={(e) => setRules({ ...rules, tablePrefix: (e.target as HTMLInputElement).value })} />
          <label class="small"><input type="checkbox" checked={!!rules.requireComment} onInput={(e) => setRules({ ...rules, requireComment: (e.target as HTMLInputElement).checked })} /> 必须有注释</label>
          <label class="small"><input type="checkbox" checked={!!rules.requirePrimaryKey} onInput={(e) => setRules({ ...rules, requirePrimaryKey: (e.target as HTMLInputElement).checked })} /> 必须有主键</label>
          <label class="small">禁用类型</label>
          <input type="text" style="width:160px" value={(rules.forbiddenTypes || []).join(',')} onInput={(e) => setRules({ ...rules, forbiddenTypes: (e.target as HTMLInputElement).value.split(',').map((s) => s.trim()).filter(Boolean) })} />
          <Btn primary onClick={() => setRun(run + 1)}>扫描</Btn>
        </div>
      </Section>

      {run > 0 && (
        <div class="grid2">
          <Section title={`违规清单（${violations.length}）`}>
            <div style="max-height:300px;overflow:auto">
              <table class="tbl small">
                <tbody>
                  {violations.map((v, i) => (
                    <tr>
                      <td>{v.rule}</td>
                      <td class="mono">{v.table}{v.column ? `.${v.column}` : ''}</td>
                      <td>{v.message}</td>
                      <td>{v.fix && <Btn onClick={() => setDict(applyFixes(dict, [v]))}>修复→{v.fix.to}</Btn>}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {violations.some((v) => v.fix) && (
              <Btn primary onClick={() => setDict(applyFixes(dict, violations))}>一键修复全部可自动项</Btn>
            )}
          </Section>
          <Section title={`注释补全建议（${suggestions.length}）`}>
            <div style="max-height:300px;overflow:auto">
              <table class="tbl small">
                <tbody>
                  {suggestions.map((s, i) => {
                    const k = `${s.table}.${s.column}`;
                    return (
                      <tr>
                        <td class="mono">{s.table}.{s.column}</td>
                        <td>{s.suggestion}</td>
                        <td><input type="checkbox" checked={!!accepted[k]} onInput={(e) => setAccepted({ ...accepted, [k]: (e.target as HTMLInputElement).checked })} /></td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
            <Btn primary onClick={() => setDict(acceptSuggestions(dict, suggestions.filter((s) => accepted[`${s.table}.${s.column}`])))}>采纳勾选项</Btn>
          </Section>
        </div>
      )}
    </div>
  );
}

// ---------- 比对修复 ----------
export function RepairPanel({ dict, setDict, dbSnap, setDbSnap, preset, projectId }: {
  dict: DictionaryModel; setDict: (d: DictionaryModel) => void;
  dbSnap: DictionaryModel | null; setDbSnap: (d: DictionaryModel | null) => void;
  preset?: ProjectConfig['connections']['db']; projectId?: string | null;
}) {
  // 初值来自「连接配置」页签的本项目 DB 连接（与 导入 页签同一套 preset）；
  // 密码不回显——留空则按 projectId 走该项目凭据库，手动填了则拉取成功后回存
  const [info, setInfo] = useState<DbConnInfo>({
    client: preset?.client || 'mysql',
    host: preset?.host || '127.0.0.1',
    port: preset?.port || 3306,
    user: preset?.user || 'root',
    password: '',
    database: preset?.database || '',
  });
  const [includeDangerous, setIncludeDangerous] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');

  const items: DiffItem[] = useMemo(() => (dbSnap ? diffDictionaries(dbSnap, dict) : []), [dbSnap, dict]);
  const fixSql = useMemo(() => (dbSnap ? generateFixSql(dbSnap, dict, includeDangerous) : []), [dbSnap, dict, includeDangerous]);

  const applyPreset = () => {
    if (!preset) return;
    setInfo({ client: preset.client || 'mysql', host: preset.host || '127.0.0.1', port: preset.port || 3306, user: preset.user || 'root', password: '', database: preset.database || '' });
  };

  const pull = async () => {
    setBusy(true); setErr('');
    try {
      const conn = { ...info, projectId: projectId ?? undefined };
      setDbSnap(await host.dbIntrospect(conn));
      if (info.password) await host.dbSavePassword({ ...conn, secretKey: undefined }, info.password);
    } catch (e: any) { setErr(String(e?.message || e)); }
    setBusy(false);
  };

  return (
    <div>
      <Section title="拉取真实库结构作为比对基准（现状）">
        <div class="row">
          <ClientPicker info={info} onChange={setInfo} />
          <input type="text" style="width:120px" placeholder="host" value={info.host} onInput={(e) => setInfo({ ...info, host: (e.target as HTMLInputElement).value })} />
          <input type="number" style="width:60px" value={info.port} onInput={(e) => setInfo({ ...info, port: Number((e.target as HTMLInputElement).value) })} />
          <input type="text" style="width:80px" placeholder="user" value={info.user} onInput={(e) => setInfo({ ...info, user: (e.target as HTMLInputElement).value })} />
          <input type="password" style="width:100px" placeholder="password" value={info.password} onInput={(e) => setInfo({ ...info, password: (e.target as HTMLInputElement).value })} />
          <input type="text" style="width:120px" placeholder={DB_PLACEHOLDER[info.client]} value={info.database} onInput={(e) => setInfo({ ...info, database: (e.target as HTMLInputElement).value })} />
          {preset && <Btn onClick={applyPreset} title="手动改过？一键还原为「连接配置」页签里的本项目 DB 连接（密码走项目凭据库）">项目连接</Btn>}
          <Btn primary onClick={pull} disabled={busy || !info.database}>{busy ? '拉取中…' : '拉取库结构'}</Btn>
        </div>
        {err && <div class="error-text">{err}</div>}
      </Section>

      {dbSnap && (
        <div>
          <div class="row" style="margin-bottom:8px">
            <span class="badge info">差异 {items.length}</span>
            <span class="badge err">危险 {items.filter((i) => i.dangerous).length}</span>
            <label class="small"><input type="checkbox" checked={includeDangerous} onInput={(e) => setIncludeDangerous((e.target as HTMLInputElement).checked)} /> 包含危险操作（DROP）</label>
            <span class="muted small">期望 = 当前字典（{dict.tables.length} 表），现状 = 库（{dbSnap.tables.length} 表）</span>
          </div>
          <div class="grid2">
            <Section title="差异明细">
              <div style="max-height:340px;overflow:auto">
                <table class="tbl small">
                  <thead><tr><th>级别</th><th>表</th><th>对象</th><th>类型</th><th>明细</th></tr></thead>
                  <tbody>
                    {items.map((it) => (
                      <tr>
                        <td>{it.level}</td><td class="mono">{it.table}</td><td class="mono">{it.object}</td>
                        <td><span class={`badge ${it.kind}`}>{it.kind}</span>{it.dangerous && ' ⚠'}</td>
                        <td class="small">{it.changes.map((c) => `${c.prop}: ${c.from} → ${c.to}`).join('；')}</td>
                      </tr>
                    ))}
                    {items.length === 0 && <tr><td colspan={5} class="muted">字典与库完全一致 🎉</td></tr>}
                  </tbody>
                </table>
              </div>
              <div class="row" style="margin-top:6px">
                <Btn onClick={() => setDict(mergeBaseIntoTarget(dbSnap, dict))}>以库为准回写字典（带变更标记）</Btn>
                <CopyBtn text={() => diffReportMarkdown(dbSnap, dict, items)} label="复制差异报告(MD)" />
              </div>
            </Section>
            <Section title={`修复 SQL（以字典为准，${fixSql.length} 条）`}>
              <pre class="out" style="max-height:340px">{fixSql.join('\n') || '无需修复'}</pre>
              <div class="row">
                <CopyBtn text={() => fixSql.join('\n')} label="复制 SQL" />
                <Btn onClick={async () => {
                  await host.saveTextFile('fix.sql', `-- 执行前请先备份！危险项默认未包含\n` + fixSql.join('\n'));
                }}>存档 fix.sql</Btn>
                <span class="small muted">建议先在库上备份/演练后执行</span>
              </div>
            </Section>
          </div>
        </div>
      )}
    </div>
  );
}

// ---------- 导出 ----------
function ExportPanel({ dict }: { dict: DictionaryModel }) {
  const [fmt, setFmt] = useState<'markdown' | 'html' | 'word' | 'mermaid' | 'ddl'>('markdown');
  const content = useMemo(() => {
    try {
      return fmt === 'markdown' ? exportMarkdown(dict)
        : fmt === 'html' ? exportHtml(dict)
          : fmt === 'word' ? exportWordHtml(dict)
            : fmt === 'mermaid' ? exportMermaid(dict)
              : exportDdl(dict);
    } catch (e: any) {
      return `导出失败: ${e?.message || e}`;
    }
  }, [dict, fmt]);

  const ext = { markdown: 'md', html: 'html', word: 'doc', mermaid: 'mmd', ddl: 'sql' }[fmt];

  const exportExcel = async () => {
    const wb = XLSX.utils.book_new();
    const sheets = buildExcelSheets(dict);
    // Excel 单工作簿最多 255 个 sheet：大字典改为单表"全部字段"台账
    if (sheets.length > 200) {
      const rows: (string | number)[][] = [['表名', '表注释', '字段', '类型', '长度', '可空', '主键', '默认值', '字段注释']];
      for (const t of dict.tables) {
        for (const c of t.columns) {
          rows.push([t.name, t.comment || '', c.name, c.type, c.length || '', c.nullable === false ? 'NO' : 'YES', c.pk ? 'PK' : '', c.defaultValue || '', c.comment || '']);
        }
      }
      XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(rows), '全部字段');
    } else {
      for (const sheet of sheets) {
        XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(sheet.rows), sheet.name);
      }
    }
    const b64 = XLSX.write(wb, { type: 'base64', bookType: 'xlsx' });
    await host.saveBinaryFile(`${dict.name}-数据字典.xlsx`, b64);
  };

  return (
    <div>
      <div class="toolbar">
        {(['markdown', 'html', 'word', 'mermaid', 'ddl'] as const).map((f) => (
          <button key={f} class={`btn${fmt === f ? ' primary' : ''}`} onClick={() => setFmt(f)} title={f === 'word' ? 'Office HTML，Word/WPS 可直接打开的 .doc' : f}>{f}</button>
        ))}
        <Btn onClick={exportExcel}>导出 Excel (.xlsx)</Btn>
        <Btn primary onClick={async () => host.saveTextFile(`${dict.name}.${ext}`, content)}>保存文件</Btn>
        <CopyBtn text={() => content} label="复制" />
      </div>
      <pre class="out" style="max-height:520px">{content}</pre>
    </div>
  );
}

// ---------- ER 图（自研轻量 SVG，不依赖 mermaid 渲染） ----------
function ErPanel({ dict }: { dict: DictionaryModel }) {
  const COLS = 4;
  const W = 220, HEADER = 26, ROW = 18, GAPX = 90, GAPY = 60, MAXROWS = 10;
  const truncated = dict.tables.length > ER_RENDER_CAP;
  const renderTables = useMemo(() => {
    if (!truncated) return dict.tables;
    // 超过上限时优先展示有关系（外键）的表，最多 60 张
    const withRelations = dict.tables.filter((t) => t.foreignKeys.length > 0 || dict.tables.some((o) => o.foreignKeys.some((f) => f.refTable === t.name)));
    return (withRelations.length ? withRelations : dict.tables).slice(0, ER_RENDER_CAP);
  }, [dict, truncated]);
  const layout = renderTables.map((t, i) => ({
    t,
    x: (i % COLS) * (W + GAPX) + 20,
    y: Math.floor(i / COLS) * (HEADER + Math.min(t.columns.length, MAXROWS) * ROW + 12 + GAPY) + 20,
  }));
  const pos = new Map(layout.map((l) => [l.t.name, l]));
  const height = (Math.ceil(renderTables.length / COLS)) * (HEADER + MAXROWS * ROW + 12 + GAPY) + 40;
  const width = COLS * (W + GAPX) + 40;

  return (
    <div>
      <div class="toolbar">
        <CopyBtn text={() => exportMermaid(dict)} label="复制 Mermaid erDiagram（可贴到文档渲染）" />
        <span class="small muted">下方为内置简易 ER 图（每表最多显示 {MAXROWS} 列）</span>
      </div>
      {truncated && (
        <div class="hint warn">共 {dict.tables.length} 张表，为保证渲染性能，ER 图仅展示有关系的前 {ER_RENDER_CAP} 张表；完整关系请用上方「复制 Mermaid erDiagram」导出。</div>
      )}
      <div class="er-wrap">
        <svg class="er-svg" width={width} height={Math.max(height, 200)}>
          {renderTables.flatMap((t) => t.foreignKeys.map((f, i) => {
            const from = pos.get(t.name);
            const to = pos.get(f.refTable);
            if (!from || !to) return null;
            const x1 = from.x + W / 2, y1 = from.y;
            const x2 = to.x + W / 2, y2 = to.y;
            return <path key={`${t.name}-${i}`} class="er-line" d={`M ${x1} ${y1} C ${x1} ${y1 - 40}, ${x2} ${y2 - 40}, ${x2} ${y2}`} markerEnd="url(#arr)" />;
          }))}
          <defs>
            <marker id="arr" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
              <path d="M 0 0 L 10 5 L 0 10 z" fill="currentColor" opacity="0.6" />
            </marker>
          </defs>
          {layout.map(({ t, x, y }) => {
            const rows = t.columns.slice(0, MAXROWS);
            const hgt = HEADER + rows.length * ROW + 6;
            return (
              <g key={t.name}>
                <rect class="er-box" x={x} y={y} width={W} height={hgt} rx={6} />
                <rect class="er-head" x={x} y={y} width={W} height={HEADER} rx={6} />
                <text class="er-title" x={x + 8} y={y + 17}>{t.name.length > 26 ? t.name.slice(0, 25) + '…' : t.name}</text>
                {rows.map((c, i) => (
                  <text key={c.name} x={x + 8} y={y + HEADER + i * ROW + 13}>
                    {c.pk ? '🔑' : '  '}{c.name} <tspan opacity="0.6">{c.type}</tspan>
                  </text>
                ))}
                {t.columns.length > MAXROWS && <text x={x + 8} y={y + hgt - 4} opacity="0.5">… 共 {t.columns.length} 列</text>}
              </g>
            );
          })}
        </svg>
      </div>
    </div>
  );
}

// ---------- 视图面板 ----------
function ViewsPanel({ dict }: { dict: DictionaryModel }) {
  if (!dict.views || dict.views.length === 0) {
    return <Section title="视图"><div class="muted">本字典未包含视图定义</div></Section>;
  }
  return (
    <div>
      <Section title={`视图列表（${dict.views.length}）`}>
        <ul class="tree">
          {dict.views.map((v) => (
            <li key={v.name}>
              <div class="node" style="cursor:pointer">
                <span class="codicon codicon-symbol-class" /> {v.name}
                {v.code && <span class="muted small"> — {v.code}</span>}
                {v.comment && <span class="muted small"> ({v.comment})</span>}
              </div>
              {v.columns.length > 0 && (
                <ul>
                  {v.columns.map((c) => (
                    <li class="node small">
                      <span class="mono">{c.name}</span>{c.code && c.code !== c.name && ` (${c.code})`}
                      <span class="muted"> {c.type}</span>
                    </li>
                  ))}
                </ul>
              )}
              {v.definition && (
                <details style="margin-top:4px">
                  <summary class="small mono">SELECT 语句</summary>
                  <pre class="out mono small">{v.definition}</pre>
                </details>
              )}
            </li>
          ))}
        </ul>
      </Section>
    </div>
  );
}

// ---------- 存储过程面板 ----------
function ProcsPanel({ dict }: { dict: DictionaryModel }) {
  if (!dict.procedures || dict.procedures.length === 0) {
    return <Section title="存储过程/函数"><div class="muted">本字典未包含存储过程或函数定义</div></Section>;
  }
  return (
    <div>
      <Section title={`存储过程/函数（${dict.procedures.length}）`}>
        <ul class="tree">
          {dict.procedures.map((p) => (
            <li key={p.name}>
              <div class="node" style="cursor:pointer">
                <span class="codicon codicon-symbol-method" /> {p.name}
                {p.code && <span class="muted small"> — {p.code}</span>}
                {p.returnType && <span class="badge info small">→ {p.returnType}</span>}
              </div>
              {p.parameters.length > 0 && (
                <table class="tbl small" style="margin-top:4px">
                  <thead><tr><th>参数</th><th>类型</th><th>方向</th><th>默认值</th></tr></thead>
                  <tbody>
                    {p.parameters.map((param) => (
                      <tr>
                        <td class="mono">{param.name}</td>
                        <td class="mono">{param.type}</td>
                        <td><span class={`badge ${param.direction === 'OUT' ? 'warn' : param.direction === 'INOUT' ? 'err' : 'info'}`}>{param.direction}</span></td>
                        <td class="mono small">{param.defaultValue ?? ''}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
              {p.body && (
                <details style="margin-top:4px">
                  <summary class="small mono">实现代码</summary>
                  <pre class="out mono small">{p.body}</pre>
                </details>
              )}
            </li>
          ))}
        </ul>
      </Section>
    </div>
  );
}

// ---------- 序列面板 ----------
function SeqsPanel({ dict }: { dict: DictionaryModel }) {
  if (!dict.sequences || dict.sequences.length === 0) {
    return <Section title="序列"><div class="muted">本字典未包含序列定义（PDM 的 o:Sequence）</div></Section>;
  }
  return (
    <div>
      <Section title={`序列（${dict.sequences.length}）`}>
        <table class="tbl">
          <thead><tr><th>序列名</th><th>起始</th><th>步长</th><th>最小</th><th>最大</th><th>当前</th><th>缓存</th><th>循环</th><th>注释</th></tr></thead>
          <tbody>
            {dict.sequences.map((s) => (
              <tr>
                <td class="mono"><b>{s.name}</b>{s.code && s.code !== s.name && ` (${s.code})`}</td>
                <td class="mono">{s.start ?? ''}</td>
                <td class="mono">{s.increment ?? ''}</td>
                <td class="mono">{s.min ?? ''}</td>
                <td class="mono">{s.max ?? ''}</td>
                <td class="mono">{s.current ?? ''}</td>
                <td class="mono">{s.cache ?? ''}</td>
                <td>{s.cycle ? <span class="badge info">CYCLE</span> : ''}</td>
                <td>{s.comment ?? ''}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </Section>
    </div>
  );
}

// ---------- 域定义面板 ----------
function DomainsPanel({ dict }: { dict: DictionaryModel }) {
  if (!dict.domains || dict.domains.length === 0) {
    return <Section title="域定义"><div class="muted">本字典未包含域定义</div></Section>;
  }
  return (
    <div>
      <Section title={`域定义（${dict.domains.length}）`}>
        <table class="tbl">
          <thead><tr><th>域名</th><th>数据类型</th><th>长度</th><th>精度</th><th>可空</th><th>默认值</th><th>约束</th><th>注释</th></tr></thead>
          <tbody>
            {dict.domains.map((d) => (
              <tr>
                <td class="mono"><b>{d.name}</b>{d.code && d.code !== d.name && ` (${d.code})`}</td>
                <td class="mono">{d.dataType}</td>
                <td class="mono">{d.length ?? ''}</td>
                <td class="mono">{d.precision ? `${d.precision}${d.scale ? `,${d.scale}` : ''}` : ''}</td>
                <td>{d.nullable === false ? 'NO' : 'YES'}</td>
                <td class="mono small">{d.defaultValue ?? ''}</td>
                <td class="mono small">{d.checkConstraint ?? ''}</td>
                <td>{d.comment ?? ''}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </Section>
    </div>
  );
}
