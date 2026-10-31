import { h } from 'preact';
import { useState, useMemo, useEffect, useRef, useCallback } from 'preact/hooks';
import * as XLSX from 'xlsx';
import { DictionaryModel, TableDef, ColumnDef, emptyDictionary, PARSER_VERSION, migrateDict, makeSourceId, DictSource, SourceKind } from '../../dictionary/model';
import { mergeBatchIntoBase, applyResolutions, defaultResolutions, removeSource, MergeConflict, MergeStats } from '../../dictionary/merge';
import { ProjectBar, SourcesPanel, MergePanel, KingdeePanel, KingdeeWebApiForm, ProjectConfigPanel, TableList, CrossProjectDiffPanel } from './dictionary/panels';
import { parsePdm } from '../../dictionary/pdm';
import { parseDdl } from '../../dictionary/ddl';
import { parseMarkdownDict } from '../../dictionary/markdown';
import { parseKingdeeHtml } from '../../dictionary/kingdee-html';
import { parseKingdeeMetadata } from '../../dictionary/kingdee';
import { emptyProjectConfig, findDbConfig, findKingdeeConfig, newConfigId, type ProjectConfig, type NamedDbConfig, type NamedKingdeeConfig, type WvPush } from '../../core/messaging';
import { diffDictionaries, generateFixSql, mergeBaseIntoTarget, diffReportMarkdown, DiffItem } from '../../dictionary/diffengine';
import { lintDictionary, applyFixes, suggestComments, acceptSuggestions, Violation, NamingRules } from '../../dictionary/naming';
import { exportMarkdown, exportHtml, exportMermaid, exportDdl, exportWordHtml, buildExcelSheets, dictStats, dictSearch, referrersOf } from '../../dictionary/exporters';
import { Btn, CopyBtn, Section, useConfirm } from '../components';
import { host, bridge } from '../bridge';
import { DbConnInfo, ProjectMeta } from '../../core/messaging';

const CLIENT_DEFAULT_PORTS: Record<DbConnInfo['client'], number> = { mysql: 3306, postgres: 5432, mssql: 1433, oracle: 1521 };
const CLIENT_LABELS: Record<DbConnInfo['client'], string> = { mysql: 'MySQL', postgres: 'PostgreSQL', mssql: 'SQL Server', oracle: 'Oracle' };
const DB_PLACEHOLDER: Record<DbConnInfo['client'], string> = { mysql: 'database', postgres: 'database', mssql: 'database', oracle: '服务名 Service Name' };
/** 构造一个来源记录（文件路径用于日后按原路径自动重解析；db/kingdee 带 configId 溯源） */
function mkSource(kind: SourceKind, name: string, path?: string, tableCount = 0, configId?: string, configName?: string): DictSource {
  return {
    id: makeSourceId(kind), kind, name, path, configId, configName,
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
  const [baseline, setBaseline] = useState<RepairBaseline | null>(null);
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

  // 最新值引用：保存/卸载 flush 时不受闭包旧值影响
  const dictRef = useRef<DictionaryModel | null>(dict);
  const currentIdRef = useRef<string | null>(currentId);
  dictRef.current = dict;
  currentIdRef.current = currentId;
  // 项目加载请求序号：快速切换时旧请求不能覆盖新项目
  const loadSeqRef = useRef(0);

  const backupKey = (id: string) => `dict:backup:${id}`;

  /** 保存到项目；成功清备份，失败把最新字典存到 workspaceState 兜底 */
  const persistDict = useCallback(async (id: string | null, d: DictionaryModel) => {
    if (!id) return false;
    try {
      await host.projectSave(id, d);
      await host.persistState(backupKey(id), null).catch(() => undefined);
      return true;
    } catch (e: any) {
      await host.persistState(backupKey(id), { dict: d, savedAt: new Date().toISOString() }).catch(() => undefined);
      host.showMessage('error', `保存到项目失败：${e?.message || e}\n已把最新字典存入本地备份，重新打开项目时会尝试恢复`).catch(() => undefined);
      return false;
    }
  }, []);

  /** 立即保存当前字典（切换项目/关闭/卸载前调用） */
  const flushSave = useCallback(async () => {
    const d = dictRef.current;
    const id = currentIdRef.current;
    if (!d) return;
    if (!id) {
      await host.persistState('dict:last', d).catch(() => undefined);
      return;
    }
    await persistDict(id, d);
  }, [persistDict]);

  // 搜索防抖：每次按键都全量扫描「表 × 字段」，1 万张表会明显卡顿，
  // 所以输入框只改 kwInput，200ms 后才同步到真正参与过滤的 keyword
  useEffect(() => {
    const t = setTimeout(() => setKeyword(kwInput), 200);
    return () => clearTimeout(t);
  }, [kwInput]);
  /** 载入（或迁移出）当前项目的字典 */
  const loadProject = async (id: string | null) => {
    const seq = ++loadSeqRef.current;
    // 先清空旧字典：避免 currentId 已切换、dict 还是旧项目时被自动保存写进新项目
    setDict(null);
    setSelected('');
    setBaseline(null);
    setPending(null);
    setConfigHash({});
    if (!id) {
      setProjectConfig(emptyProjectConfig());
      setSecretKeys([]);
      setDbSecretKeys([]);
      setCacheMeta({});
      return;
    }
    // 连接配置 / 凭据摘要 / 缓存状态互不依赖：并行拉取，缩短切换窗口
    const [r, sk, dbk, cm] = await Promise.all([
      host.projectGetConfig(id).catch(() => null),
      host.projectReadSecretExists(id, 'kingdee').catch(() => [] as string[]),
      host.projectReadSecretExists(id, 'db').catch(() => [] as string[]),
      host.projectCacheMeta(id).catch(() => ({})),
    ]);
    if (seq !== loadSeqRef.current) return;
    if (r) {
      setProjectConfig(r.config ?? emptyProjectConfig());
      setConfigDefaults(r.defaults ?? {});
      setConfigHash(r.hash ?? {});
    } else {
      setProjectConfig(emptyProjectConfig());
    }
    setSecretKeys(sk);
    setDbSecretKeys(dbk);
    setCacheMeta(cm);
  
    let d: DictionaryModel | null = null;
    try {
      d = await host.projectLoad(id);
    } catch (e: any) {
      if (seq === loadSeqRef.current) {
        host.showMessage('error', `读取项目字典失败：${e?.message || e}`).catch(() => undefined);
      }
    }
    if (seq !== loadSeqRef.current) return;
  
    // 上次保存失败时会在 workspaceState 留一份最新备份；它比项目文件新，优先恢复
    const backup = await host.readState<any>(backupKey(id)).catch(() => null);
    if (seq !== loadSeqRef.current) return;
    if (backup?.dict && Array.isArray(backup.dict.tables) && backup.dict.tables.length > 0) {
      try {
        const m = migrateDict(backup.dict);
        setDict(m);
        setSelected(m.tables[0]?.name || '');
        const ok = await persistDict(id, m);
        host.showMessage('warn', `项目字典为空或上次保存失败，已从本地备份恢复${ok ? '并写回项目' : '，但写回项目仍失败，请立即导出备份'}`).catch(() => undefined);
        return;
      } catch { /* 备份损坏：继续用项目文件 */ }
    }
    
    if (d && Array.isArray(d.tables) && d.tables.length > 0) {
      try {
        const m = migrateDict(d);
        setDict(m);
        setSelected(m.tables[0]?.name || '');
      } catch (e: any) {
        setDict(null);
        host.showMessage('error', `项目字典损坏：${e?.message || e}`).catch(() => undefined);
      }
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
            await persistDict(p.id, migrateDict(old));
            list = await host.projectList();
            host.showMessage('info', `已把旧版字典迁移为项目「${p.name}」，以后跨工作区也能直接用`).catch(() => undefined);
          }
        }
        setProjects(list.projects);
        const id = list.currentId ?? list.projects[0]?.id ?? null;
        setCurrentId(id);
        await loadProject(id);
      } catch (e: any) {
        host.showMessage('error', `项目库读取失败：${e?.message || e}`).catch(() => undefined);
        // 项目库不可用时退回旧的 workspaceState 恢复逻辑（只作为兜底，不覆盖项目文件）
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
    try {
      const list = await host.projectList();
      setProjects(list.projects);
      const id = switchTo ?? list.currentId ?? list.projects[0]?.id ?? null;
      setCurrentId(id);
      return id;
    } catch (e: any) {
      host.showMessage('error', `读取项目列表失败：${e?.message || e}`).catch(() => undefined);
      return currentIdRef.current;
    }
  };

  // 字典变化时持久化到项目文件（防抖 500ms）
  useEffect(() => {
    if (!dict) return;
    const timer = setTimeout(() => { void flushSave(); }, 500);
    return () => clearTimeout(timer);
  }, [dict, currentId, flushSave]);
  
  // 卸载（切工具/关面板）前立即保存，避免防抖窗口内丢失最后一次编辑
  useEffect(() => () => { void flushSave(); }, [flushSave]);

  // 双栏视图需要页面自身不滚动（左右两栏各自滚）。这里显式通知外层，
  // 不用 CSS :has —— 部分二开内核不支持，会导致"左栏滚不动、整页在滚"
  useEffect(() => {
    // 冲突面板需要普通页面滚动；双栏浏览才让出滚动权
    setFill?.(!!dict && tab === 'browse' && !pending);
    return () => setFill?.(false);
  }, [tab, dict, pending]);

  // ---------- 导入（多来源合并） ----------
  /**
   * 把一次解析结果作为"来源"并入当前字典；有冲突则先弹冲突面板。
   * projectId/base 两个入参必须显式传：state 更新是异步的，
   * 靠闭包里的 currentId/dict 会拿到旧值（建项目后立即递归 → 无限建项目）。
   */
  /** 保存字典到项目：失败必须让用户知道（静默失败 = 换工作区才发现数据没了） */
  const saveOrWarn = (id: string, d: DictionaryModel) => {
    void persistDict(id, d);
  };

  const applyBatch = (
    parsed: { dict: DictionaryModel; source: DictSource }[],
    opts?: { projectId?: string | null; base?: DictionaryModel | null; sync?: { kind: 'db' | 'kingdee'; dict: DictionaryModel; meta?: any } },
  ): boolean => {
    const id = opts?.projectId !== undefined ? opts.projectId : currentId;
    const base = opts?.base !== undefined ? opts.base : dict;
    const valid = parsed.filter((p) => p.dict.tables.length > 0);
    const failed = parsed.filter((p) => p.dict.tables.length === 0);

    if (!id) {
      // 没有项目时先建一个，避免数据无处可存
      const first = valid[0];
      if (!first) {
        host.showMessage('error', '导入失败：未解析到任何表').catch(() => undefined);
        return false;
      }
      host.projectCreate(first.dict.name || first.source.name || '默认项目').then(async (p) => {
        setDict(null); setSelected('');
        await refreshProjects(p.id);
        applyBatch(parsed, { projectId: p.id, base, sync: opts?.sync });
      }).catch(() => undefined);
      return false;
    }

    if (!valid.length) {
      const detail = failed.map((f) => `${f.source.name}：${f.dict.importErrors[0]?.message || '未解析到表'}`).join('\n');
      host.showMessage('error', `导入失败：未解析到任何表。\n${detail}`).catch(() => undefined);
      return false;
    }
    if (failed.length) {
      host.showMessage('warn', `${failed.length} 个文件未解析到表：${failed.map((f) => f.source.name).join('、')}`).catch(() => undefined);
    }
    for (const p of valid) {
      p.dict.meta = { ...p.dict.meta, importedAt: new Date().toISOString(), parser: PARSER_VERSION, source: p.source.name, sourcePath: p.source.path };
    }

    const hadBase = !!base && base.tables.length > 0;
    const start = hadBase ? base! : emptyDictionary(valid[0].dict.name || valid[0].source.name, valid[0].dict.dialect);
    const r = mergeBatchIntoBase(start, valid);
    if (r.conflicts.length > 0) {
      setPending({
        merged: r.dict,
        conflicts: r.conflicts,
        resolutions: defaultResolutions(r.conflicts, 'base'),
        stats: r.stats,
        sourceName: valid.length > 1 ? `${valid.length} 个文件` : valid[0].source.name,
        sync: opts?.sync,
      });
      return true;
    }
    const m = migrateDict(r.dict);
    setDict(m);
    if (!hadBase) setSelected(m.tables[0]?.name || '');
    setTab('browse');
    saveOrWarn(id, m);
    const scope = valid.length > 1 ? `（${valid.length} 个文件）` : '';
    const added = hadBase ? `新增 ${r.stats.tablesAdded} 表 / ${r.stats.columnsAdded} 字段，` : '';
    host.showMessage('info', `${hadBase ? '合并完成' : '导入完成'}${scope}：${added}共 ${m.tables.length} 张表`).catch(() => undefined);
    return false;
  };

  const applyImport = (
    d: DictionaryModel,
    source: DictSource,
    opts?: { projectId?: string | null; base?: DictionaryModel | null; sync?: { kind: 'db' | 'kingdee'; dict: DictionaryModel; meta?: any } },
  ): boolean => applyBatch([{ dict: d, source }], opts);

  /** 数据库导入弹窗里自动保存连接配置（输入即存，供下次直接选） */
  const saveDbConfig = async (cfg: NamedDbConfig) => {
    if (!currentId) return;
    const list = [...(projectConfig.connections?.db || [])];
    const idx = list.findIndex((x) => x.id === cfg.id);
    if (idx >= 0) list[idx] = cfg; else list.push(cfg);
    const next: ProjectConfig = { ...projectConfig, connections: { ...projectConfig.connections, db: list } };
    setProjectConfig(next);
    await host.projectSaveConfig(currentId, next);
    await refreshProjects();
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
    await persistDict(currentId, m);
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
      else if (ext === 'html' || ext === 'htm') nd = parseKingdeeHtml(r.content);
      else if (ext === 'xml') nd = parseKingdeeMetadata(r.content, s.name);
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
    await persistDict(currentId, m);
  };

  /** 通用导入：按扩展名自动选择解析器（来源面板/工具栏的"导入新来源"用它） */
  const importAny = async () => {
    const f = await host.openTextFile();
    if (!f) return;
    const ext = (f.name.split('.').pop() || '').toLowerCase();
    if (ext === 'pdm') return importPdmWith(f);
    if (ext === 'sql') return importDdlWith(f);
    if (ext === 'md') return importMdWith(f);
    if (ext === 'html' || ext === 'htm') return importHtmlWith(f);
    if (ext === 'xml') return importXmlWith(f);
    if (ext === 'json') return importDtcatWith(f);
    host.showMessage('warn', `暂不支持的文件类型 .${ext}（支持 pdm / sql / md / html / xml / json）`).catch(() => undefined);
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
  const importHtmlWith = async (f: { name: string; path?: string; content: string }) => {
    const d = parseKingdeeHtml(f.content);
    d.name = f.name.replace(/\.html?$/i, '');
    applyImport(d, mkSource('kingdee-html', f.name, f.path, d.tables.length));
  };
  const importXmlWith = async (f: { name: string; path?: string; content: string }) => {
    const d = parseKingdeeMetadata(f.content, f.name);
    if (!d.tables.length) {
      host.showMessage('error', `未解析到表：${d.importErrors[0]?.message || '请确认是金蝶云星空导出的 XML 表单模型'}`).catch(() => undefined);
      return;
    }
    d.name = f.name.replace(/\.xml$/i, '') || d.name;
    applyImport(d, mkSource('kingdee', f.name, f.path, d.tables.length));
  };
  const importDtcatWith = async (f: { name: string; path?: string; content: string }) => {
    try {
      const d = parseDtcat(f.content, f.name);
      applyImport(d, mkSource('dtcat', f.name, f.path, d.tables.length));
    } catch (e: any) {
      host.showMessage('error', `加载失败: ${e?.message || e}`);
    }
  };
  /** 「同步」：用本项目的连接重新拉取 → 撤掉旧来源贡献 → 按新结果合并（差异走冲突面板由你确认） */
  const syncSource = async (id: string, kind: 'db' | 'kingdee') => {
    if (!currentId) return;
    try {
      const s = (dict?.sources || []).find((x) => x.id === id);
      const r = await host.projectSync(currentId, kind, s?.configId);
      if (!r?.ok || !r.dict) { await host.showMessage('error', `同步失败：${r?.error || '未知错误'}`); return; }
      const stripped = dict ? removeSource(dict, id).dict : null;
      const deferred = applyImport(r.dict, {
        id,
        kind,
        name: s?.name || (kind === 'db' ? '在线库' : '金蝶元数据'),
        configId: s?.configId ?? r.meta?.configId,
        configName: s?.configName ?? r.meta?.configName,
        priority: s?.priority ?? 20,
        enabled: true,
        importedAt: r.meta?.importedAt || new Date().toISOString(),
        tableCount: r.dict.tables.length,
      }, { projectId: currentId, base: stripped, sync: { kind, dict: r.dict, meta: r.meta } });
      // 无冲突时上面已直接落地，这里补写缓存；有冲突则交给冲突面板确认后再写
      if (!deferred) {
        await host.projectSaveCache(currentId, kind, r.dict, r.meta, s?.configId ?? r.meta?.configId).catch(() => undefined);
      }
      setCacheMeta(await host.projectCacheMeta(currentId));
    } catch (e: any) {
      await host.showMessage('error', `同步失败：${e?.message || e}`);
    }
  };

  /** 跨项目比对：当前项目字典 vs 另一个项目的字典 */
  const runCrossDiff = async () => {
    if (!currentId || !diffOther) return;
    setDiffBusy(true);
    try {
      const r = await host.projectDiff(currentId, diffOther);
      if (!r?.ok) { await host.showMessage('error', `比对失败：${r?.error || '未知错误'}`); return; }
      setDiffResult(r);
    } catch (e: any) {
      await host.showMessage('error', `比对失败：${e?.message || e}`);
    } finally {
      setDiffBusy(false);
    }
  };

  /** 连接配置页的「测试连接 / 测试 WebAPI 配置」：先落盘再测，避免测的是没保存的参数 */
  const testConn = async (kind: 'db' | 'kingdee', cfg: ProjectConfig, secrets: any, configId?: string): Promise<string> => {
    if (!currentId) return '未选中项目';
    try {
      await host.projectSaveConfig(currentId, cfg);
      if (secrets?.dbPassword) await host.projectSaveSecret(currentId, 'db', { password: secrets.dbPassword }, configId);
      const kv: Record<string, string> = {};
      if (secrets?.appSecret) kv.appSecret = secrets.appSecret;
      if (secrets?.password) kv.password = secrets.password;
      if (Object.keys(kv).length) await host.projectSaveSecret(currentId, 'kingdee', kv, configId);
      setProjectConfig(cfg);
      if (kind === 'db') {
        const dbc = findDbConfig(cfg, configId);
        return await host.dbTestConnection({ client: dbc?.client, host: dbc?.host, port: dbc?.port, user: dbc?.user, database: dbc?.database, password: secrets?.dbPassword || '', projectId: currentId, configId } as any);
      }
      const r = await host.kingdeeTestConfig(currentId, configId);
      return r.ok ? r.message : `✗ ${r.message}`;
    } catch (e: any) {
      return `✗ ${e?.message || e}`;
    }
  };

  const importPdm = async () => {
    const files = await host.openTextFiles(['pdm']);
    if (!files?.length) return;
    const parsed: { dict: DictionaryModel; source: DictSource }[] = [];
    for (const f of files) {
      const d = parsePdm(f.content);
      d.name = f.name.replace(/\.pdm$/i, '');
      parsed.push({ dict: d, source: mkSource('pdm', f.name, f.path, d.tables.length) });
      // 大文件逐个解析时让出主线程，避免一次性卡死 UI
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    applyBatch(parsed);
  };
  const importDdl = async () => { const f = await host.openTextFile(); if (f) await importDdlWith(f); };
  const importMd = async () => { const f = await host.openTextFile(); if (f) await importMdWith(f); };
  const importHtml = async () => { const f = await host.openTextFile(); if (f) await importHtmlWith(f); };
  const importXml = async () => { const f = await host.openTextFile(); if (f) await importXmlWith(f); };
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
  const finishImport = (d: DictionaryModel, name: string, kind: SourceKind = 'db', configId?: string, configName?: string) => {
    applyImport(d, mkSource(kind, name || d.name || kind, undefined, d.tables.length, configId, configName));
  };

  // ---------- 渲染 ----------
  // 连接配置面板：提取出来复用——空字典时（新建项目后）也要能进配置页
  const configPane = (
    <Section title="连接配置">
      {currentId ? (
        <ProjectConfigPanel
          projectName={projects.find((x) => x.id === currentId)?.name || '当前项目'}
          projectId={currentId}
          config={projectConfig}
          defaults={configDefaults}
          onTest={testConn}
          onSave={async (cfg, secrets) => {
            await host.projectSaveConfig(currentId, cfg);
            if (secrets.dbPassword) await host.projectSaveSecret(currentId, 'db', { password: secrets.dbPassword }, secrets.dbConfigId);
            const kv: Record<string, string> = {};
            if (secrets.appSecret) kv.appSecret = secrets.appSecret;
            if (secrets.password) kv.password = secrets.password;
            if (Object.keys(kv).length) await host.projectSaveSecret(currentId, 'kingdee', kv, secrets.kdConfigId);
            setProjectConfig(cfg);
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
          onSwitch={async (id) => { await flushSave(); setDict(null); setSelected(''); await host.projectSwitch(id); const nid = await refreshProjects(id); await loadProject(nid); }}
          onCreate={async (name) => { await flushSave(); await host.projectCreate(name); await loadProject(null); await refreshProjects(); }}
          onRename={async (name) => { if (currentId) { await host.projectRename(currentId, name); await refreshProjects(); } }}
          onClear={async () => { if (currentId) { const id = currentId; setDict(null); setSelected(''); await host.persistState(backupKey(id), null).catch(() => undefined); await host.projectClear(id); await loadProject(null); await refreshProjects(); } }}
          onDelete={async () => { if (currentId) { const id = currentId; setDict(null); setSelected(''); await host.persistState(backupKey(id), null).catch(() => undefined); await host.projectDelete(id); const next = await refreshProjects(); await loadProject(next); } }}
          onExport={() => { if (currentId) host.projectExport(currentId, `${projects.find((p) => p.id === currentId)?.name || 'project'}.dtproj.json`).catch(() => undefined); }}
          onImport={async () => { await flushSave(); const p = await host.projectImport(); if (!p) return; setDict(null); setSelected(''); const id = await refreshProjects(); await loadProject(id); }}
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
            <Btn primary onClick={importPdm} title="选择一个或多个 PowerDesigner .pdm 文件">导入 PDM (PowerDesigner)</Btn>
            <Btn primary onClick={importDdl}>导入 DDL (.sql)</Btn>
            <Btn primary onClick={importMd}>导入 Markdown 字典</Btn>
            <Btn primary onClick={importHtml}>导入金蝶 HTML 字典</Btn>
            <Btn primary onClick={importXml}>导入金蝶 XML 元数据</Btn>
            <Btn primary onClick={importExcel}>导入 Excel 字典</Btn>
            <Btn onClick={importDtcat}>加载 .dtcat.json</Btn>
          </div>
          <div class="toolbar" style="margin-top:8px">
            <DbImportForm
              projectId={currentId}
              preset={projectConfig.connections?.db}
              onConfigSaved={saveDbConfig}
              onImported={(d, cid) => finishImport(d, `${d.name || '数据库'}`, 'db', cid, (projectConfig.connections?.db || []).find((c) => c.id === cid)?.name)}
            />
          </div>
          <div class="small muted">选择一个已保存的 SQL 连接或新建；填写的连接信息会自动保存到「连接配置」。</div>
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
        onSwitch={async (id) => { await flushSave(); setDict(null); setSelected(''); await host.projectSwitch(id); const nid = await refreshProjects(id); await loadProject(nid); }}
        onCreate={async (name) => { await flushSave(); const p = await host.projectCreate(name); await loadProject(null); await refreshProjects(p.id); }}
        onRename={async (name) => { if (currentId) { await host.projectRename(currentId, name); await refreshProjects(); } }}
        onClear={async () => { if (currentId) { const id = currentId; setDict(null); setSelected(''); await host.persistState(backupKey(id), null).catch(() => undefined); await host.projectClear(id); await loadProject(null); await refreshProjects(); } }}
        onDelete={async () => { if (currentId) { const id = currentId; setDict(null); setSelected(''); await host.persistState(backupKey(id), null).catch(() => undefined); await host.projectDelete(id); const next = await refreshProjects(); await loadProject(next); } }}
        onExport={() => { if (currentId) host.projectExport(currentId, `${projects.find((p) => p.id === currentId)?.name || 'project'}.dtproj.json`).catch(() => undefined); }}
        onImport={async () => { await flushSave(); const p = await host.projectImport(); if (!p) return; setDict(null); setSelected(''); const id = await refreshProjects(); await loadProject(id); }}
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
        <Btn onClick={importPdm} title="导入一个或多个 PowerDesigner .pdm 文件">PDM</Btn>
        <Btn onClick={importDdl} title="导入 DDL 建表语句 (.sql)">DDL</Btn>
        <Btn onClick={importMd} title="导入 Markdown 格式数据字典">MD</Btn>
        <Btn onClick={importHtml} title="导入金蝶数据字典 HTML（枚举并入注释）">HTML</Btn>
        <Btn onClick={importXml} title="导入金蝶云星空 XML 表单模型">XML</Btn>
        <Btn onClick={importExcel} title="导入 Excel 数据字典 (.xlsx/.xls)">Excel</Btn>
        <Btn onClick={saveDtcat} title="保存为 .dtcat.json 文件（可进 Git 版本管理）">保存 .dtcat.json</Btn>
        <Btn onClick={async () => { await flushSave(); setDict(null); setSelected(''); setBaseline(null); host.persistState('dict:last', null).catch(() => undefined); }} title="关闭字典并清除缓存">关闭</Btn>
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
            keyword={kwInput}
            activeKeyword={keyword}
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
      {tab === 'repair' && <RepairPanel dict={dict} setDict={setDict} baseline={baseline} setBaseline={setBaseline} dbConfigs={projectConfig.connections?.db} kdConfigs={projectConfig.connections?.kingdee} projectId={currentId} />}
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
            <DbImportForm projectId={currentId} preset={projectConfig.connections?.db} onConfigSaved={saveDbConfig} onImported={(d, cid) => finishImport(d, `${d.name || '数据库'}`, 'db', cid, (projectConfig.connections?.db || []).find((c) => c.id === cid)?.name)} />
          </Section>
          <KingdeePanel projectId={currentId} configs={projectConfig.connections?.kingdee} onImport={(d, name, cid) => finishImport(d, name, 'kingdee', cid, (projectConfig.connections?.kingdee || []).find((c) => c.id === cid)?.name)} />
        </div>
      )}
    </div>
  );
}

// ---------- 在线库导入表单 ----------
function initInfo(c?: NamedDbConfig): DbConnInfo {
  return {
    client: c?.client || 'mysql',
    host: c?.host || '127.0.0.1',
    port: c?.port || 3306,
    user: c?.user || 'root',
    password: '',
    database: c?.database || '',
    configId: c?.id,
  };
}

export function DbImportForm({ projectId, preset, onImported, onConfigSaved }: {
  projectId?: string | null;
  preset?: NamedDbConfig[];
  onImported: (d: DictionaryModel, configId?: string) => void;
  onConfigSaved?: (cfg: NamedDbConfig) => Promise<void> | void;
}) {
  const [open, setOpen] = useState(false);
  const [cfgId, setCfgId] = useState('');
  const [info, setInfo] = useState<DbConnInfo>(() => initInfo((preset || [])[0]));
  const [busy, setBusy] = useState('');
  const [msg, setMsg] = useState('');
  const [dirty, setDirty] = useState(false);
  const [savedTip, setSavedTip] = useState('');
  const [progress, setProgress] = useState<{ current: number; total: number; phase?: string } | null>(null);
  const progressIdRef = useRef('');
  // 同步记录当前配置 id：避免自动保存与测试/导入并发时重复创建配置
  const cfgIdRef = useRef<string | undefined>((preset || [])[0]?.id);
  // 编辑序号：保存期间又有输入时，不能把新改动误标为已保存
  const editRef = useRef(0);

  // 宿主在读取库结构时推送阶段进度（表清单/字段/索引/外键）
  useEffect(() => {
    const h = (m: WvPush) => {
      if (m.event !== 'dbProgress') return;
      const p = m.payload as any;
      if (!p || p.id !== progressIdRef.current) return;
      setProgress({ current: Number(p.current) || 0, total: Number(p.total) || 0, phase: p.phase });
    };
    bridge.pushHandlers.push(h);
    return () => { const i = bridge.pushHandlers.indexOf(h); if (i >= 0) bridge.pushHandlers.splice(i, 1); };
  }, []);

  const mark = (next: DbConnInfo) => { editRef.current++; setInfo(next); setDirty(true); setSavedTip(''); };
  const patch = (p: Partial<DbConnInfo>) => mark({ ...info, ...p });

  const openModal = () => {
    const first = (preset || [])[0];
    cfgIdRef.current = first?.id;
    setCfgId(first?.id || '');
    setInfo(initInfo(first));
    setMsg(''); setDirty(false); setSavedTip(''); setOpen(true);
  };

  const applyCfg = (id: string) => {
    if (!id) {
      cfgIdRef.current = undefined;
      setCfgId('');
      setInfo({ client: 'mysql', host: '127.0.0.1', port: 3306, user: 'root', password: '', database: '', configId: undefined });
      setDirty(false); setSavedTip('');
      return;
    }
    const c = (preset || []).find((x) => x.id === id);
    if (!c) return;
    cfgIdRef.current = id;
    setCfgId(id);
    setInfo({ client: c.client || 'mysql', host: c.host || '127.0.0.1', port: c.port || 3306, user: c.user || 'root', password: '', database: c.database || '', configId: c.id });
    setDirty(false); setSavedTip('');
  };

  const nameFor = (id: string) => {
    const existing = (preset || []).find((x) => x.id === id);
    // 用户手动改过名就不再覆盖
    if (existing && existing.autoName === false) return existing.name;
    const host = info.host.trim();
    const db = info.database.trim();
    const base = host || db || `数据库 ${(preset || []).length + 1}`;
    // 同一主机多条时用 host/db 区分，避免重名
    const dup = (preset || []).some((c) => c.id !== id && c.name === base);
    return dup && db ? `${base}/${db}` : base;
  };

  /** 输入即存：把当前连接信息写回项目连接配置（密码仍走凭据库，测试/导入时保存） */
  const ensureSaved = async (): Promise<string | undefined> => {
    if (!projectId || !onConfigSaved) return info.configId;
    if (!info.host.trim() && !info.database.trim()) return info.configId;
    const id = info.configId || cfgIdRef.current || newConfigId();
    cfgIdRef.current = id;
    const version = editRef.current;
    const existing = (preset || []).find((x) => x.id === id);
    const cfg: NamedDbConfig = { id, name: nameFor(id), autoName: existing?.autoName !== false, client: info.client, host: info.host, port: info.port, user: info.user, database: info.database };
    await onConfigSaved(cfg);
    if (info.configId !== id) setInfo((prev) => ({ ...prev, configId: id }));
    setCfgId(id);
    // 保存期间又改过：保持 dirty，让防抖任务再存一次
    if (editRef.current === version) { setDirty(false); setSavedTip('配置已自动保存'); }
    return id;
  };

  useEffect(() => {
    if (!open || !dirty || !projectId || !onConfigSaved) return;
    if (!info.host.trim() && !info.database.trim()) return;
    const t = setTimeout(() => { ensureSaved().catch(() => undefined); }, 700);
    return () => clearTimeout(t);
  }, [open, dirty, info, projectId, onConfigSaved, preset]);

  // 带上 projectId + configId：密码优先从该项目该配置的凭据里取，实现"同库不同配置不同密码"
  const connWith = (id?: string) => ({ ...info, configId: id, projectId: projectId ?? undefined });

  const test = async () => {
    setBusy('test'); setMsg('');
    try {
      const id = await ensureSaved();
      const conn = connWith(id);
      if (info.password) await host.dbSavePassword({ ...conn, secretKey: undefined }, info.password);
      setMsg(`✓ ${await host.dbTestConnection(conn)}`);
    } catch (e: any) { setMsg(`✗ ${e?.message || e}`); }
    setBusy('');
  };
  const imp = async () => {
    const pid = `db_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
    progressIdRef.current = pid;
    setProgress({ current: 0, total: 0, phase: '连接数据库并读取结构…' });
    setBusy('import'); setMsg('');
    try {
      const id = await ensureSaved();
      const conn = connWith(id);
      const d = await host.dbIntrospect(conn, pid);
      if (info.password) await host.dbSavePassword({ ...conn, secretKey: undefined }, info.password);
      onImported(d, id);
      setOpen(false);
    } catch (e: any) { setMsg(`✗ ${e?.message || e}`); }
    finally { setBusy(''); setProgress(null); progressIdRef.current = ''; }
  };

  return (
    <div>
      <Btn primary onClick={openModal} title="选择或新建 SQL 连接，从数据库反向导入">从数据库导入</Btn>
      {open && (
        <div class="modal-mask" onClick={() => setOpen(false)}>
          <div class="modal-card" style="width:min(760px, calc(100vw - 40px));max-height:calc(100vh - 80px);overflow:auto" onClick={(e) => e.stopPropagation()}>
            <div class="modal-title">从数据库导入</div>
            <div class="small muted">选择项目里已保存的连接，或直接填写；连接信息会在输入后自动保存到「连接配置」。</div>
            {(preset || []).length > 0 && (
              <label class="row" style="gap:8px">
                <span class="small muted">连接配置</span>
                <select value={cfgId} onInput={(e) => applyCfg((e.target as HTMLSelectElement).value)}>
                  <option value="">（新建连接）</option>
                  {(preset || []).map((c) => <option value={c.id}>{c.name}（{c.host}/{c.database}）</option>)}
                </select>
              </label>
            )}
            <div class="form-grid">
              <label class="fld"><span>数据库类型</span><ClientPicker info={info} onChange={mark} /></label>
              <label class="fld"><span>主机</span><input type="text" placeholder="127.0.0.1" value={info.host} onInput={(e) => patch({ host: (e.target as HTMLInputElement).value })} /></label>
              <label class="fld"><span>端口</span><input type="number" value={info.port} onInput={(e) => patch({ port: Number((e.target as HTMLInputElement).value) })} /></label>
              <label class="fld"><span>用户名</span><input type="text" placeholder="user" value={info.user} onInput={(e) => patch({ user: (e.target as HTMLInputElement).value })} /></label>
              <label class="fld"><span>密码</span><input type="password" placeholder={cfgId ? '留空=用已保存密码' : 'password'} value={info.password} onInput={(e) => patch({ password: (e.target as HTMLInputElement).value })} onBlur={async () => {
                if (!info.password) return;
                try { const id = await ensureSaved(); if (id) await host.dbSavePassword({ ...connWith(id), secretKey: undefined }, info.password); } catch { /* 测试/导入时会再报 */ }
              }} /></label>
              <label class="fld"><span>库名 / 服务名</span><input type="text" placeholder={DB_PLACEHOLDER[info.client]} value={info.database} onInput={(e) => patch({ database: (e.target as HTMLInputElement).value })} /></label>
            </div>
            {savedTip && <div class="small muted">{savedTip}</div>}
            {busy === 'import' && (
              <div class="progress-wrap">
                <div class="progress-track">
                  <div
                    class={`progress-fill${progress && progress.total > 0 && progress.current > 0 ? '' : ' indeterminate'}`}
                    style={progress && progress.total > 0 ? `width:${Math.min(100, Math.round((progress.current / progress.total) * 100))}%` : undefined}
                  />
                </div>
                <div class="small muted">
                  {progress?.phase || '正在读取库结构…'}
                  {progress && progress.total > 0 ? ` ${Math.min(100, Math.round((progress.current / progress.total) * 100))}%` : ''}
                </div>
              </div>
            )}
            {msg && <div class={`small mono ${msg.startsWith('✗') ? 'error-text' : ''}`} style="white-space:pre-wrap;word-break:break-all">{msg}</div>}
            <div class="row" style="justify-content:flex-end;gap:8px">
              <Btn onClick={() => setOpen(false)}>取消</Btn>
              <Btn onClick={test} disabled={!!busy}>{busy === 'test' ? '测试中…' : '测试连接'}</Btn>
              <Btn primary onClick={imp} disabled={!!busy || !info.database}>{busy === 'import' ? '导入中…' : '导入'}</Btn>
            </div>
          </div>
        </div>
      )}
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
export type BaselineKind = 'sqlserver' | 'mysql' | 'postgres' | 'oracle' | 'webapi' | 'json' | 'kingdee-html' | 'kingdee-xml';
/** 一级基线类别：数据库（下再选具体 DB）/ WebAPI / 金蝶云星空表单模型 / JSON */
export type BaselineCategory = 'database' | 'webapi' | 'kingdee' | 'json';
export interface RepairBaseline {
  dict: DictionaryModel;
  kind: BaselineKind;
  label: string;
  /** 拉取时的连接信息：切到别的页签再回来时恢复表单（不含密码） */
  conn?: DbConnInfo;
  kdConfigId?: string;
  jsonPicked?: string;
  jsonMode?: 'file' | 'paste';
  /** 金蝶云星空 HTML/XML 文件名（切页签恢复用） */
  kingdeePicked?: string;
}

/** 数据库基线类型 → client / 默认端口 / 默认用户 */
const DB_BASELINE_KINDS: { id: BaselineKind; label: string; client: DbConnInfo['client']; port: number; user: string }[] = [
  { id: 'sqlserver', label: 'SQL Server', client: 'mssql', port: 1433, user: 'sa' },
  { id: 'mysql', label: 'MySQL', client: 'mysql', port: 3306, user: 'root' },
  { id: 'postgres', label: 'PostgreSQL', client: 'postgres', port: 5432, user: 'postgres' },
  { id: 'oracle', label: 'Oracle', client: 'oracle', port: 1521, user: '' },
];
const BASELINE_KINDS: { id: BaselineKind; label: string }[] = [
  ...DB_BASELINE_KINDS.map((k) => ({ id: k.id, label: k.label })),
  { id: 'webapi', label: '金蝶 WebAPI' },
  { id: 'kingdee-html', label: '金蝶云星空 HTML' },
  { id: 'kingdee-xml', label: '金蝶云星空 XML' },
  { id: 'json', label: 'JSON 文件' },
];
const isDbKind = (k: BaselineKind) => DB_BASELINE_KINDS.some((d) => d.id === k);

/** .dtcat.json 校验解析（「导入」页签与「比对修复」JSON 基线共用） */
export function parseDtcat(content: string, name: string): DictionaryModel {
  let d: any;
  try { d = JSON.parse(content); } catch (e: any) { throw new Error(`${name}: 不是合法 JSON（${e?.message || e}）`); }
  if (!d || d.version !== 1 || !Array.isArray(d.tables)) throw new Error(`${name} 不是有效的 .dtcat.json`);
  return d as DictionaryModel;
}

/** 基线 kind → 连接初值；从项目配置里挑 client 匹配的一条预填（密码不回显，走凭据库） */
function connFor(kind: BaselineKind, preset?: NamedDbConfig[]): DbConnInfo {
  const meta = DB_BASELINE_KINDS.find((d) => d.id === kind) || DB_BASELINE_KINDS[0];
  const p = (preset || []).find((c) => c.client === meta.client);
  return {
    client: meta.client,
    host: p?.host || '127.0.0.1',
    port: p?.port || meta.port,
    user: p?.user || meta.user,
    password: '',
    database: p?.database || '',
    configId: p?.id,
  };
}

export function RepairPanel({ dict, setDict, baseline, setBaseline, dbConfigs, kdConfigs, projectId }: {
  dict: DictionaryModel; setDict: (d: DictionaryModel) => void;
  baseline: RepairBaseline | null; setBaseline: (b: RepairBaseline | null) => void;
  dbConfigs?: NamedDbConfig[]; kdConfigs?: NamedKingdeeConfig[]; projectId?: string | null;
}) {
  const initialKind = baseline?.kind ?? 'sqlserver';
  const [kind, setKind] = useState<BaselineKind>(initialKind);
  // 记住数据库子类型：切到 WebAPI/JSON 再切回时不丢上次选择
  const [lastDbKind, setLastDbKind] = useState<BaselineKind>(isDbKind(initialKind) ? initialKind : 'sqlserver');
  const [info, setInfo] = useState<DbConnInfo>(() => (baseline?.conn ? { ...baseline.conn, password: '' } : connFor(initialKind, dbConfigs)));
  const [jsonPicked, setJsonPicked] = useState(baseline?.jsonPicked || '');
  const [jsonMode, setJsonMode] = useState<'file' | 'paste'>(baseline?.jsonMode || 'file');
  const [kingdeePicked, setKingdeePicked] = useState(baseline?.kingdeePicked || '');
  const [jsonText, setJsonText] = useState('');
  const [kdConfigId, setKdConfigId] = useState<string>(baseline?.kdConfigId || kdConfigs?.[0]?.id || '');
  const [includeDangerous, setIncludeDangerous] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [writeMsg, setWriteMsg] = useState('');
  const { confirm, confirmNode } = useConfirm();
  // 比对范围与降噪：默认只比对基线（WebAPI/JSON/库）返回的表
  const [fullCompare, setFullCompare] = useState(false);
  const [ignoreComments, setIgnoreComments] = useState(false);
  const [ignoreDefaults, setIgnoreDefaults] = useState(false);
  const [ignoreNullable, setIgnoreNullable] = useState(false);
  // 金蝶 WebAPI 的 ID 字段是 bigint，PDM 常写 int；默认视为同一类型，避免满屏假差异
  const [ignoreIntegerWidth, setIgnoreIntegerWidth] = useState(false);
  // 切页签会卸载本面板；基线本身存在父组件，挂载时从它恢复来源/连接，避免回到默认值
  useEffect(() => {
    if (!baseline) return;
    setKind(baseline.kind);
    if (isDbKind(baseline.kind)) {
      setLastDbKind(baseline.kind);
      setInfo(baseline.conn ? { ...baseline.conn, password: '' } : connFor(baseline.kind, dbConfigs));
    }
    setKdConfigId(baseline.kdConfigId || kdConfigs?.[0]?.id || '');
    setJsonPicked(baseline.jsonPicked || '');
    setJsonMode(baseline.jsonMode || 'file');
    setKingdeePicked(baseline.kingdeePicked || '');
  }, [baseline?.kind, baseline?.label]);

  // 金蝶 WebAPI 元数据不是物理 schema：MustInput 不等于可空性，DefValue 是界面默认值，注释是 UI 标题；
  // 默认忽略这三类不可靠字段，避免 FAllowATPCheck 这类假差异；用户可手动关闭。
  useEffect(() => {
    const meta = baseline?.kind === 'webapi' || baseline?.kind === 'kingdee-xml';
    setIgnoreComments(meta);
    setIgnoreDefaults(meta);
    setIgnoreNullable(meta);
    setIgnoreIntegerWidth(meta);
  }, [baseline?.kind, baseline?.label]);
  const [kindFilter, setKindFilter] = useState<'all' | 'added' | 'removed' | 'modified' | 'dangerous'>('all');
  const [levelFilter, setLevelFilter] = useState<'all' | 'table' | 'column' | 'index' | 'fk'>('all');
  const [propFilter, setPropFilter] = useState('all');
  const [tableFilter, setTableFilter] = useState('');
  const [diffKw, setDiffKw] = useState('');

  const diffOpts = useMemo(
    () => {
      const meta = baseline?.kind === 'webapi' || baseline?.kind === 'kingdee-xml';
      return {
        fullCompare, ignoreComments, ignoreDefaults, ignoreNullable, ignoreIntegerWidth,
        // 金蝶 WebAPI / XML 元数据：不返回索引/外键，也不含系统字段（如 FMasterId）
        skipRelations: meta,
        metadataBaseline: meta,
        // HTML 数据字典有主外键表，但没有引用表信息，跳过外键避免误生成 ADD CONSTRAINT
        skipForeignKeys: baseline?.kind === 'kingdee-html',
      };
    },
    [fullCompare, ignoreComments, ignoreDefaults, ignoreNullable, ignoreIntegerWidth, baseline?.kind],
  );
  const itemsAll: DiffItem[] = useMemo(
    () => (baseline ? diffDictionaries(baseline.dict, dict, diffOpts) : []),
    [baseline, dict, diffOpts],
  );
  // 可选表列表（只含基线范围内出现差异的表）
  const tableOptions = useMemo(() => [...new Set(itemsAll.map((i) => i.table))].sort(), [itemsAll]);
  const items: DiffItem[] = useMemo(() => {
    const kw = diffKw.trim().toLowerCase();
    return itemsAll.filter((it) => {
      if (kindFilter === 'dangerous') { if (!it.dangerous) return false; }
      else if (kindFilter !== 'all' && it.kind !== kindFilter) return false;
      if (levelFilter !== 'all' && it.level !== levelFilter) return false;
      if (propFilter !== 'all' && !it.changes.some((c) => c.prop === propFilter)) return false;
      if (tableFilter && it.table !== tableFilter) return false;
      if (kw && !(it.table.toLowerCase().includes(kw) || it.object.toLowerCase().includes(kw))) return false;
      return true;
    });
  }, [itemsAll, kindFilter, levelFilter, propFilter, tableFilter, diffKw]);
  const filterActive = kindFilter !== 'all' || levelFilter !== 'all' || propFilter !== 'all' || !!tableFilter || !!diffKw.trim();
  const resetFilters = () => { setKindFilter('all'); setLevelFilter('all'); setPropFilter('all'); setTableFilter(''); setDiffKw(''); };
  const fixSql = useMemo(
    () => (baseline ? generateFixSql(baseline.dict, dict, includeDangerous, diffOpts) : []),
    [baseline, dict, includeDangerous, diffOpts],
  );
  // 按表分组（局部基线下通常只有几组）；上限 500 条防全量模式卡顿
  const grouped = useMemo(() => {
    const CAP = 500;
    const shown = items.slice(0, CAP);
    const m = new Map<string, DiffItem[]>();
    for (const it of shown) {
      const arr = m.get(it.table);
      if (arr) arr.push(it); else m.set(it.table, [it]);
    }
    return { entries: [...m.entries()], shown: shown.length, total: items.length, capped: items.length > CAP };
  }, [items]);

  const isDb = isDbKind(kind);
  const isKingdeeModel = kind === 'kingdee-html' || kind === 'kingdee-xml';
  const category: BaselineCategory = kind === 'webapi' ? 'webapi'
    : kind === 'json' ? 'json'
      : isKingdeeModel ? 'kingdee'
        : 'database';
  const dbKind: BaselineKind = isDb ? kind : lastDbKind;

  const switchKind = (k: BaselineKind) => {
    setKind(k);
    if (isDbKind(k)) { setLastDbKind(k); setInfo(connFor(k, dbConfigs)); }
    setErr('');
  };
  const setCategory = (c: BaselineCategory) => {
    if (c === 'database') switchKind(lastDbKind);
    else if (c === 'kingdee') switchKind(isKingdeeModel ? kind : 'kingdee-html');
    else switchKind(c);
  };

  /** 从项目某条 DB 配置预填（切换类型 + 连接信息） */
  const applyDbConfig = (configId: string) => {
    const c = (dbConfigs || []).find((x) => x.id === configId);
    if (!c) return;
    const k = DB_BASELINE_KINDS.find((d) => d.client === c.client)?.id || 'mysql';
    setKind(k); setLastDbKind(k);
    setInfo({ client: c.client || 'mysql', host: c.host || '127.0.0.1', port: c.port || 3306, user: c.user || '', password: '', database: c.database || '', configId: c.id });
    setErr('');
  };

  const pullDb = async () => {
    setBusy(true); setErr('');
    try {
      const conn = { ...info, projectId: projectId ?? undefined };
      const d = await host.dbIntrospect(conn);
      if (info.password) await host.dbSavePassword({ ...conn, secretKey: undefined }, info.password);
      setJsonPicked('');
      setBaseline({ dict: d, kind, label: `${info.host}:${info.port}/${info.database}`, conn: { ...info, password: '' } });
    } catch (e: any) { setErr(String(e?.message || e)); }
    setBusy(false);
  };

  const pickJson = async () => {
    setBusy(true); setErr('');
    try {
      const f = await host.openTextFile();
      if (!f) return;
      const d = parseDtcat(f.content, f.name);
      setJsonPicked(`${f.name}（${d.tables.length} 表）`);
      setBaseline({ dict: d, kind: 'json', label: f.name, jsonPicked: `${f.name}（${d.tables.length} 表）`, jsonMode: 'file' });
    } catch (e: any) { setErr(String(e?.message || e)); }
    finally { setBusy(false); }
  };

  const parseJsonText = () => {
    setErr('');
    try {
      const d = parseDtcat(jsonText, '粘贴的 JSON');
      setJsonPicked(`粘贴内容（${d.tables.length} 表）`);
      setBaseline({ dict: d, kind: 'json', label: '粘贴 JSON', jsonPicked: `粘贴内容（${d.tables.length} 表）`, jsonMode: 'paste' });
    } catch (e: any) { setErr(String(e?.message || e)); }
  };

  /** 金蝶云星空表单模型：HTML 数据字典 / XML 元数据 */
  const pickKingdeeFile = async () => {
    const wantHtml = kind === 'kingdee-html';
    setBusy(true); setErr('');
    try {
      const f = await host.openTextFile();
      if (!f) return;
      const lower = f.name.toLowerCase();
      if (wantHtml && !/\.(html?|htm)$/.test(lower)) { setErr('请选择 .html / .htm 文件'); return; }
      if (!wantHtml && !/\.xml$/.test(lower)) { setErr('请选择 .xml 文件'); return; }
      const d = wantHtml ? parseKingdeeHtml(f.content) : parseKingdeeMetadata(f.content, f.name);
      if (!d.tables.length) {
        setErr(d.importErrors[0]?.message || '未解析到任何表，请确认是从金蝶云星空导出的数据模型');
        return;
      }
      const picked = `${f.name}（${d.tables.length} 表）`;
      setKingdeePicked(picked);
      setBaseline({ dict: d, kind: wantHtml ? 'kingdee-html' : 'kingdee-xml', label: picked, kingdeePicked: picked });
    } catch (e: any) { setErr(String(e?.message || e)); }
    finally { setBusy(false); }
  };

  return (
    <div>
      <Section title="拉取真实结构作为比对基准（现状）">
        {/* 选择行：基线来源 /（数据库）类型 /（有配置时）项目配置 /（多配置时）金蝶配置 */}
        <div class="row" style="margin-bottom:10px;gap:12px">
          <label class="row" style="gap:6px">
            <span class="small muted">基线来源</span>
            <select name="dt-baseline-cat" value={category} onInput={(e) => setCategory((e.target as HTMLSelectElement).value as BaselineCategory)}>
              <option value="database">数据库</option>
              <option value="webapi">金蝶 WebAPI</option>
              <option value="kingdee">金蝶云星空（表单模型）</option>
              <option value="json">JSON 文件</option>
            </select>
          </label>
          {category === 'database' && (
            <label class="row" style="gap:6px">
              <span class="small muted">类型</span>
              <select name="dt-baseline-kind" value={dbKind} onInput={(e) => switchKind((e.target as HTMLSelectElement).value as BaselineKind)}>
                {DB_BASELINE_KINDS.map((d) => <option value={d.id}>{d.label}</option>)}
              </select>
            </label>
          )}
          {category === 'database' && (dbConfigs || []).length > 0 && (
            <label class="row" style="gap:6px">
              <span class="small muted">项目配置</span>
              <select value={info.configId || ''} onInput={(e) => { const v = (e.target as HTMLSelectElement).value; if (v) applyDbConfig(v); }}>
                <option value="">（手动填写）</option>
                {(dbConfigs || []).map((c) => <option value={c.id}>{c.name}（{c.host}/{c.database}）</option>)}
              </select>
            </label>
          )}
          {category === 'kingdee' && (
            <label class="row" style="gap:6px">
              <span class="small muted">文件类型</span>
              <select value={kind} onInput={(e) => switchKind((e.target as HTMLSelectElement).value as BaselineKind)}>
                <option value="kingdee-html">HTML 数据字典</option>
                <option value="kingdee-xml">XML 元数据</option>
              </select>
            </label>
          )}
          {kind === 'webapi' && (kdConfigs || []).length > 1 && (
            <label class="row" style="gap:6px">
              <span class="small muted">金蝶配置</span>
              <select value={kdConfigId} onInput={(e) => setKdConfigId((e.target as HTMLSelectElement).value)}>
                {(kdConfigs || []).map((c) => <option value={c.id}>{c.name}</option>)}
              </select>
            </label>
          )}
        </div>

        {isDb && (
          <div>
            <div class="form-grid">
              <label class="fld"><span>主机</span>
                <input type="text" placeholder="127.0.0.1" value={info.host} onInput={(e) => setInfo({ ...info, host: (e.target as HTMLInputElement).value })} />
              </label>
              <label class="fld"><span>端口</span>
                <input type="number" value={info.port} onInput={(e) => setInfo({ ...info, port: Number((e.target as HTMLInputElement).value) })} />
              </label>
              <label class="fld"><span>用户名</span>
                <input type="text" placeholder="user" value={info.user} onInput={(e) => setInfo({ ...info, user: (e.target as HTMLInputElement).value })} />
              </label>
              <label class="fld"><span>密码</span>
                <input type="password" placeholder={info.configId ? '留空=用项目凭据' : 'password'} value={info.password} onInput={(e) => setInfo({ ...info, password: (e.target as HTMLInputElement).value })} />
              </label>
              <label class="fld"><span>库名 / 服务名</span>
                <input type="text" placeholder="database / service name" value={info.database} onInput={(e) => setInfo({ ...info, database: (e.target as HTMLInputElement).value })} />
              </label>
            </div>
            <div class="row" style="justify-content:flex-end;margin-top:10px">
              <Btn primary onClick={pullDb} disabled={busy || !info.database}>{busy ? '拉取中…' : '拉取库结构'}</Btn>
            </div>
          </div>
        )}
        {kind === 'webapi' && (
          <KingdeeWebApiForm projectId={projectId} configId={kdConfigId || kdConfigs?.[0]?.id} onFetched={(d, label) => { setJsonPicked(''); setBaseline({ dict: d, kind: 'webapi', label, kdConfigId }); }} />
        )}
        {isKingdeeModel && (
          <div>
            <div class="row">
              <Btn primary onClick={pickKingdeeFile} disabled={busy}>{busy ? '解析中…' : (kind === 'kingdee-html' ? '选择 .html 数据字典' : '选择 .xml 元数据')}</Btn>
              {kingdeePicked && <span class="small muted">{kingdeePicked}</span>}
            </div>
            <div class="small muted" style="margin-top:6px">
              {kind === 'kingdee-html'
                ? '从金蝶云星空导出的数据字典 HTML（UTF-16 自动识别，枚举值并入注释）。'
                : '金蝶云星空表单模型 XML（QueryBusinessInfo 元数据格式，自动按表单/字段解析）。'}
            </div>
          </div>
        )}
        {kind === 'json' && (
          <div>
            <div class="row" style="margin-bottom:8px;gap:8px">
              <button class={`btn${jsonMode === 'file' ? ' primary' : ''}`} onClick={() => setJsonMode('file')}>导入文件</button>
              <button class={`btn${jsonMode === 'paste' ? ' primary' : ''}`} onClick={() => setJsonMode('paste')}>粘贴 JSON</button>
            </div>
            {jsonMode === 'file' && (
              <div class="row">
                <Btn onClick={pickJson} disabled={busy}>{jsonPicked ? '重选 .dtcat.json' : '选择 .dtcat.json'}</Btn>
                {jsonPicked && <span class="small muted">{jsonPicked}</span>}
              </div>
            )}
            {jsonMode === 'paste' && (
              <div>
                <textarea class="mono" rows={8} style="width:100%" placeholder='粘贴 .dtcat.json 内容：{"version":1,"tables":[...]}' value={jsonText} onInput={(e) => setJsonText((e.target as HTMLTextAreaElement).value)} />
                <div class="row" style="justify-content:flex-end;margin-top:8px"><Btn primary onClick={parseJsonText} disabled={!jsonText.trim()}>解析为基线</Btn></div>
              </div>
            )}
          </div>
        )}
        {err && <div class="error-text">{err}</div>}
      </Section>

      {baseline && (
        <div>
          <div class="row" style="margin-bottom:6px;flex-wrap:wrap;gap:12px">
            <span class="badge info">差异 {items.length}{items.length !== itemsAll.length ? ` / ${itemsAll.length}` : ''}</span>
            <span class="badge err">危险 {itemsAll.filter((i) => i.dangerous).length}</span>
            <label class="small" title="只比对基线报文里返回的表；字典其余表不参与"><input type="checkbox" checked={fullCompare} onInput={(e) => setFullCompare((e.target as HTMLInputElement).checked)} /> 全量比对（含字典额外表）</label>
            <label class="small"><input type="checkbox" checked={ignoreComments} onInput={(e) => setIgnoreComments((e.target as HTMLInputElement).checked)} /> 忽略注释差异</label>
            <label class="small"><input type="checkbox" checked={ignoreDefaults} onInput={(e) => setIgnoreDefaults((e.target as HTMLInputElement).checked)} /> 忽略默认值差异</label>
            <label class="small"><input type="checkbox" checked={ignoreNullable} onInput={(e) => setIgnoreNullable((e.target as HTMLInputElement).checked)} /> 忽略可空差异</label>
            <label class="small" title="金蝶元数据常用 bigint，PDM 常写 int；勾选后 int/bigint/smallint 视为同一类型"><input type="checkbox" checked={ignoreIntegerWidth} onInput={(e) => setIgnoreIntegerWidth((e.target as HTMLInputElement).checked)} /> 忽略整型宽度</label>
            <label class="small"><input type="checkbox" checked={includeDangerous} onInput={(e) => setIncludeDangerous((e.target as HTMLInputElement).checked)} /> 含危险操作（DROP）</label>
          </div>
          <div class="small muted" style="margin-bottom:8px">
            比对范围：基线 [{BASELINE_KINDS.find((k) => k.id === baseline!.kind)?.label}] {baseline.label}（{baseline.dict.tables.length} 表） ↔ 字典（{dict.tables.length} 表）
            · {fullCompare ? '全量比对' : '仅基线返回的表（字典其余表不参与）'}
            · 基线=现状，字典=期望；字典独有=现状缺、基线独有=字典未收录（默认不 DROP）
            · 类型按统一类型族比较（int/bigint、varchar/char、datetime/datetime2 等），不再按字符串直比
            {baseline.kind === 'webapi' && ' · 元数据只校验表单字段，字典多出的系统字段不反向报缺'}
            {baseline.kind === 'kingdee-xml' && ' · XML 元数据只校验表单字段，字典多出的系统字段不反向报缺'}
          </div>
          <div class="row" style="margin-bottom:6px;gap:6px;flex-wrap:wrap">
            {([['all', '全部'], ['modified', '变更'], ['removed', '基线独有'], ['added', '字典独有'], ['dangerous', '危险']] as const).map(([k, label]) => (
              <button class={`btn${kindFilter === k ? ' primary' : ''}`} onClick={() => setKindFilter(k)}>{label}</button>
            ))}
            <span class="grow" />
            <span class="small muted">筛选 {items.length} / {itemsAll.length}</span>
            {filterActive && <Btn onClick={resetFilters}>重置</Btn>}
          </div>
          <div class="row" style="margin-bottom:8px;gap:8px;flex-wrap:wrap">
            <label class="row" style="gap:4px"><span class="small muted">级别</span>
              <select value={levelFilter} onInput={(e) => setLevelFilter((e.target as HTMLSelectElement).value as 'all' | 'table' | 'column' | 'index' | 'fk')}>
                <option value="all">全部</option>
                <option value="table">表</option>
                <option value="column">字段</option>
                <option value="index">索引</option>
                <option value="fk">外键</option>
              </select>
            </label>
            <label class="row" style="gap:4px"><span class="small muted">变更项</span>
              <select value={propFilter} onInput={(e) => setPropFilter((e.target as HTMLSelectElement).value)}>
                <option value="all">全部</option>
                <option value="类型">类型</option>
                <option value="可空">可空</option>
                <option value="默认值">默认值</option>
                <option value="注释">注释</option>
                <option value="主键">主键</option>
                <option value="唯一">唯一</option>
              </select>
            </label>
            <label class="row" style="gap:4px"><span class="small muted">表</span>
              <select value={tableFilter} onInput={(e) => setTableFilter((e.target as HTMLSelectElement).value)}>
                <option value="">全部</option>
                {tableOptions.map((t) => <option value={t}>{t}</option>)}
              </select>
            </label>
            <input type="text" style="width:180px" placeholder="搜索表名/字段…" value={diffKw} onInput={(e) => setDiffKw((e.target as HTMLInputElement).value)} />
            {grouped.capped && <span class="small muted">仅显示前 {grouped.shown} 条（共 {grouped.total} 条），请用筛选/搜索</span>}
          </div>
          <div class="grid2">
            <Section title="差异明细">
              <div style="max-height:420px;overflow:auto">
                {grouped.entries.length === 0 && <div class="muted small">无差异（或已被筛选掉）</div>}
                {grouped.entries.map(([tbl, its]) => (
                  <details open key={tbl} style="margin-bottom:6px">
                    <summary class="small"><b class="mono">{tbl}</b> <span class="muted">（{its.length} 处差异）</span></summary>
                    <table class="tbl small" style="margin-top:4px">
                      <thead><tr><th>级别</th><th>对象</th><th>类型</th><th>明细</th></tr></thead>
                      <tbody>
                        {its.map((it, idx) => (
                          <tr key={idx}>
                            <td>{it.level}</td>
                            <td class="mono">{it.object}</td>
                            <td><span class={`badge ${it.kind}`} title={it.kind === 'added' ? '字典有、基线无 → 现状需要新增' : it.kind === 'removed' ? '基线有、字典未收录 → 默认不生成 DROP' : '双方都有但定义不同'}>{it.kind === 'added' ? '字典独有' : it.kind === 'removed' ? '基线独有' : '变更'}</span>{it.dangerous && ' ⚠'}</td>
                            <td class="small">{it.changes.map((c) => `${c.prop}: ${c.from} → ${c.to}`).join('；')}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </details>
                ))}
              </div>
              <div class="row" style="margin-top:6px">
                <Btn onClick={async () => {
                  if (!baseline) return;
                  const ok = await confirm(`当前差异 ${itemsAll.length} 处。将以基线「${baseline.label}」覆盖字典里的同名表/字段定义，并标记变更；字典独有的表不会被删除。是否写入？`);
                  if (!ok) return;
                  const merged = mergeBaseIntoTarget(baseline.dict, dict, diffOpts);
                  setDict(merged);
                  const n = merged.tables.reduce((s, t) => s + (t.changeTag ? 1 : 0) + t.columns.filter((c) => c.changeTag).length, 0);
                  setWriteMsg(`已按基线回写：${merged.tables.length} 张表，标记 ${n} 处变更`);
                  host.showMessage('info', `已按基线回写字典：标记 ${n} 处变更`).catch(() => undefined);
                }}>以基线为准回写字典（带变更标记）</Btn>
                <CopyBtn text={() => diffReportMarkdown(baseline!.dict, dict, itemsAll)} label="复制差异报告(MD)" />
                {writeMsg && <span class="small muted">{writeMsg}</span>}
              </div>
            </Section>
            <Section title={`修复 SQL（以字典为准，${fixSql.length} 条）`}>
              {baseline.kind === 'webapi' && (
                <div class="small muted" style="margin-bottom:6px">仅参考：金蝶端没有 DDL 执行通道，以下 SQL 只用于你自己数据库的对齐，不要在金蝶上执行。</div>
              )}
              {baseline.kind === 'kingdee-xml' && (
                <div class="small muted" style="margin-bottom:6px">仅参考：XML 表单模型不是物理库，以下 SQL 只用于你自己数据库的对齐，不要在金蝶上执行。</div>
              )}
              <pre class="out" style="max-height:420px">{fixSql.join('\n') || '无需修复'}</pre>
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
      {confirmNode}
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
