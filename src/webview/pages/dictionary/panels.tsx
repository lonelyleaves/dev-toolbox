import { h } from 'preact';
import { useState, useMemo, useEffect, useRef } from 'preact/hooks';
import { Btn, Section, useConfirm, usePrompt } from '../../components';
import { ProjectMeta, ProjectConfig } from '../../../core/messaging';
import { host } from '../../bridge';
import { parseKingdeeMetadata } from '../../../dictionary/kingdee';
import { DictionaryModel, DictSource, SourceKind } from '../../../dictionary/model';
import { tablesMatching } from '../../../dictionary/search-index';
import { MergeConflict } from '../../../dictionary/merge';

const KIND_LABEL: Record<SourceKind, string> = {
  pdm: 'PDM', ddl: 'DDL', md: 'Markdown', excel: 'Excel', db: '数据库', kingdee: '金蝶', 'kingdee-html': '金蝶HTML', dtcat: '字典文件',
};

export function sourceKindLabel(k: SourceKind): string {
  return KIND_LABEL[k] || k;
}

/* ---------------- 项目栏 ---------------- */

/* ---------------- 相对时间 ---------------- */

/** 相对时间：刚刚 / 5 分钟前 / 3 小时前 / 2 天前；超过 30 天直接给日期 */
export function relTime(iso: string): string {
  if (!iso) return '-';
  const t = new Date(iso).getTime();
  if (!Number.isFinite(t)) return '-';
  const diff = Date.now() - t;
  const abs = Math.abs(diff);
  const suffix = diff >= 0 ? '前' : '后';
  if (abs < 60000) return '刚刚';
  if (abs < 3600000) return `${Math.floor(abs / 60000)} 分钟${suffix}`;
  if (abs < 86400000) return `${Math.floor(abs / 3600000)} 小时${suffix}`;
  if (abs < 30 * 86400000) return `${Math.floor(abs / 86400000)} 天${suffix}`;
  return new Date(t).toLocaleDateString('zh-CN');
}
export function ProjectBar(p: {
  projects: ProjectMeta[];
  currentId: string | null;
  onSwitch: (id: string) => void;
  onCreate: (name: string) => void;
  onRename: (name: string) => void;
  onClear: () => void;
  onDelete: () => void;
  onExport: () => void;
  onImport: () => void;
  onConfig: () => void;
}) {
  const [name, setName] = useState('');
  const { confirm, confirmNode } = useConfirm();
  const { prompt, promptNode } = usePrompt();
  const cur = p.projects.find((x) => x.id === p.currentId);
  const dbOk = !!cur?.configSummary?.db;
  const kdOk = !!cur?.configSummary?.kingdee;
  return (
    <div class="toolbar" style="flex-wrap:wrap; gap:8px; margin-bottom:10px">
      <div
        class="row"
        title="数据库连接 / 金蝶连接是否已配置（点击前往配置）"
        onClick={() => p.onConfig()}
        style="flex:none; gap:5px; cursor:pointer"
      >
        <span class={`dot${dbOk ? ' ok' : ''}`} title="数据库连接" />
        <span class={`dot${kdOk ? ' ok' : ''}`} title="金蝶连接" />
      </div>
      <select
        value={p.currentId ?? ''}
        onInput={(e) => { const v = (e.target as HTMLSelectElement).value; if (v) p.onSwitch(v); }}
        title="切换项目（项目数据存于扩展全局目录，跨工作区复用）"
      >
        {p.projects.length === 0 && <option value="">（无项目）</option>}
        {p.projects.map((pr) => (
          <option value={pr.id}>{pr.name}（{pr.tableCount} 表 / {pr.sourceCount} 来源）</option>
        ))}
      </select>
      <input
        type="text"
        placeholder="新项目名"
        value={name}
        style="width:140px"
        onInput={(e) => setName((e.target as HTMLInputElement).value)}
      />
      <Btn onClick={() => { if (name.trim()) { p.onCreate(name.trim()); setName(''); } }}>+ 新建项目</Btn>
      <Btn onClick={async () => { const n = cur ? await prompt('重命名项目', cur.name) : null; if (n && n.trim()) p.onRename(n.trim()); }}>重命名</Btn>
      <Btn onClick={p.onImport}>导入项目包</Btn>
      <Btn onClick={p.onExport}>导出项目包</Btn>
      <Btn onClick={async () => { if (cur && await confirm(`清空项目「${cur.name}」的所有字典数据与来源？项目本身保留。`)) p.onClear(); }}>清空</Btn>
      <Btn onClick={async () => { if (cur && await confirm(`删除项目「${cur.name}」？该项目的字典数据将一并删除。`)) p.onDelete(); }}>删除</Btn>
      {confirmNode}
      {promptNode}
    </div>
  );
}

/* ---------------- 来源面板 ---------------- */

export function SourcesPanel(p: {
  dict: DictionaryModel;
  onRemove: (id: string) => void;
  onToggle: (id: string) => void;
  onRefresh: (id: string) => void;
  onAdd: () => void;
  onSync: (id: string, kind: 'db' | 'kingdee') => void;
  cacheMeta?: Record<string, { importedAt?: string; stale?: boolean; tableCount?: number; configHash?: string; configId?: string; configName?: string }>;
  hash?: Record<string, string>;
}) {
  const sources = p.dict.sources || [];
  const { confirm, confirmNode } = useConfirm();

  /** 判断该来源的缓存是否已过期（对应配置的连接指纹变了）；按 kind__configId 槽位取 */
  const staleNow = (s: any) => {
    const slot = !s.configId || s.configId === 'default' ? s.kind : `${s.kind}__${s.configId}`;
    const m = (p.cacheMeta || {})[slot];
    if (!m) return false;
    // 宿主已算好 stale 就以它为准（它同时握着缓存指纹与当前指纹，最准）；
    // 拿不到时再退回前端自己比对，避免字段缺失导致提示永远不亮
    if (typeof m.stale === 'boolean') return m.stale;
    const now = (p.hash || {})[slot];
    return !!m.configHash && !!now && m.configHash !== now;
  };
  if (sources.length === 0) {
    return <Section title="来源"><div class="muted small">暂无来源，点击下方按钮导入 PDM / DDL / Markdown / Excel / 数据库 / 金蝶元数据</div></Section>;
  }
  return (
    <div>
      <Section title={`来源（${sources.length}）`}>
        <table class="tbl">
          <thead><tr><th>类型</th><th>名称</th><th>表数</th><th>导入时间</th><th>优先级</th><th>状态</th><th>操作</th></tr></thead>
          <tbody>
            {sources.map((s) => (
              <tr>
                <td><span class="badge info">{sourceKindLabel(s.kind)}</span></td>
                <td class="mono" title={s.path || s.conn || ''}>{s.name}</td>
                <td>{s.tableCount}</td>
                <td class="small" title={new Date(s.importedAt).toLocaleString('zh-CN')}>{relTime(s.importedAt)}</td>
                <td>{s.priority}</td>
                <td>{s.enabled ? '启用' : <span class="muted">已禁用</span>}</td>
                <td>
                  {(s.kind === 'db' || s.kind === 'kingdee') && (
                    <a
                      class="link"
                      href="#"
                      onClick={(e) => { e.preventDefault(); p.onSync(s.id, s.kind as 'db' | 'kingdee'); }}
                      title="用本项目的连接重新拉取并对比差异，由你确认是否覆盖"
                    >
                      同步{staleNow(s) ? ' · 连接已变更' : ''}
                    </a>
                  )}
                  {' '}
                  {s.path && <a class="link" href="#" onClick={(e) => { e.preventDefault(); p.onRefresh(s.id); }} title="按原路径重新解析该来源">刷新</a>}
                  {' '}
                  <a class="link" href="#" onClick={(e) => { e.preventDefault(); p.onToggle(s.id); }}>{s.enabled ? '禁用' : '启用'}</a>
                  {' '}
                  <a class="link" href="#" onClick={async (e) => { e.preventDefault(); if (await confirm(`移除来源「${s.name}」？该来源带来的表与字段会一并删除。`)) p.onRemove(s.id); }}>移除</a>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </Section>
      <div class="toolbar"><Btn primary onClick={p.onAdd}>+ 导入新来源</Btn></div>
      {confirmNode}
    </div>
  );
}

/* ---------------- 金蝶云星空接入 ---------------- */

/** 金蝶 WebAPI 直连表单（「扩展字段」页签与「比对修复」页签共用） */
export function KingdeeWebApiForm(p: { projectId?: string | null; configId?: string; onFetched: (dict: DictionaryModel, label: string, raw: string) => void }) {
  const [formIds, setFormIds] = useState('');
  const [secret, setSecret] = useState('');
  const [pwd, setPwd] = useState('');
  const [msg, setMsg] = useState('');
  const [busy, setBusy] = useState(false);

  const doFetch = async () => {
    const ids = formIds.split(/[,，\s]+/).map((s) => s.trim()).filter(Boolean);
    if (!ids.length) { setMsg('请填写至少一个表单标识，如 BD_MATERIAL'); return; }
    setBusy(true);
    setMsg('正在登录并拉取元数据…');
    try {
      if (secret || pwd) await host.kingdeeSaveSecret(secret || undefined, pwd || undefined, p.projectId ?? undefined, p.configId);
      const r = await host.kingdeeFetchMetadata(ids, { projectId: p.projectId ?? undefined, configId: p.configId, appSecret: secret || undefined, password: pwd || undefined });
      if (!r.ok) { setMsg(`✗ ${r.error}`); return; }
      const d = parseKingdeeMetadata(r.text || '', '金蝶 ' + ids.join(','));
      if (!d.tables.length) {
        const preview = String(r.text || '').replace(/\s+/g, ' ').slice(0, 500);
        setMsg(`已取到报文但未能识别结构：${d.importErrors[0]?.message || '未识别到表单/字段'}。原始返回（前 500 字）：${preview}`);
        return;
      }
      p.onFetched(d, `金蝶 ${ids.join(',')}`, r.text || '');
      setMsg(`✓ 拉取并解析出 ${d.tables.length} 张表`);
    } catch (e: any) {
      setMsg(`✗ ${e?.message || e}`);
    } finally { setBusy(false); }
  };

  return (
    <div>
      <div class="form-grid">
        <label class="fld" style="grid-column:1 / -1"><span>表单标识（逗号分隔）</span>
          <input type="text" placeholder="表单标识，逗号分隔，如 BD_MATERIAL,BD_CUSTOMER" value={formIds} onInput={(e) => setFormIds((e.target as HTMLInputElement).value)} />
        </label>
        <label class="fld"><span>appSecret</span>
          <input type="password" placeholder="appSecret（留空用已存）" value={secret} onInput={(e) => setSecret((e.target as HTMLInputElement).value)} />
        </label>
        <label class="fld"><span>登录密码</span>
          <input type="password" placeholder="登录密码（留空用已存）" value={pwd} onInput={(e) => setPwd((e.target as HTMLInputElement).value)} />
        </label>
      </div>
      <div class="row" style="justify-content:flex-end;margin-top:10px">
        <Btn primary onClick={doFetch} disabled={busy}>{busy ? '拉取中…' : '拉取元数据'}</Btn>
      </div>
      {msg && <div class="small" style="margin-top:6px">{msg}</div>}
    </div>
  );
}

export function KingdeePanel(p: { projectId?: string | null; configs?: import('../../../core/messaging').NamedKingdeeConfig[]; onImport: (dict: any, name: string, configId?: string) => void }) {
  const [raw, setRaw] = useState('');
  const [msg, setMsg] = useState('');
  const [cfgId, setCfgId] = useState(p.configs?.[0]?.id || '');
  const activeCfg = () => cfgId || p.configs?.[0]?.id;

  const doParse = () => {
    if (!raw.trim()) { setMsg('请先粘贴金蝶元数据或 WebAPI 返回报文'); return; }
    const d = parseKingdeeMetadata(raw, '金蝶元数据');
    if (!d.tables.length) { setMsg(`✗ ${d.importErrors[0]?.message || '未识别到表单/字段'}`); return; }
    p.onImport(d, '金蝶元数据', activeCfg());
    setMsg(`✓ 解析出 ${d.tables.length} 张表，已按合并规则并入`);
  };

  return (
    <div>
      <Section title="金蝶云星空 · 方式一：粘贴报文/元数据">
        <div class="small muted" style="margin-bottom:6px">
          把表单元数据（XML/JSON）或 WebAPI 返回的报文直接粘进来即可，不需要网络与账号。
          官方报文语义：Key=字段名、Name=中文标题、MustInput=1 → 必填、IsViewVisible=false → 界面已隐藏。
          多语言字段（FName/FDescription 等）会按金蝶物理结构自动归入 {'<表>_L'} 表。
        </div>
        <textarea
          class="mono"
          rows={8}
          placeholder='{"Result":{"FormId":"BD_MATERIAL","Name":"物料","Entity":[{"Key":"FNUMBER","Name":"物料编码","MustInput":1}]}}'
          value={raw}
          onInput={(e) => setRaw((e.target as HTMLTextAreaElement).value)}
        />
        <div class="toolbar" style="margin-top:6px"><Btn primary onClick={doParse}>解析并合并</Btn></div>
      </Section>

      <Section title="金蝶云星空 · 方式二：WebAPI 直连">
        <div class="small muted" style="margin-bottom:6px">
          接口地址、账套、应用 Id 在「连接配置」页签配置（可配多条）；appSecret 与密码只存 VS Code 凭据库，不进项目文件。
          多语言字段（含自定义多语言字段）会自动拆到 {'<表>_L'}，并补齐 FLOCALEID，与真实库结构一致。
        </div>
        {(p.configs || []).length > 1 && (
          <div class="row" style="margin-bottom:6px;gap:8px">
            <span class="small muted">金蝶配置：</span>
            <select value={cfgId} onInput={(e) => setCfgId((e.target as HTMLSelectElement).value)}>
              {(p.configs || []).map((c) => <option value={c.id}>{c.name}</option>)}
            </select>
          </div>
        )}
        <KingdeeWebApiForm
          projectId={p.projectId}
          configId={cfgId || p.configs?.[0]?.id}
          onFetched={(d, label, rawText) => {
            setRaw(rawText);
            p.onImport(d, label, activeCfg());
            setMsg(`✓ 拉取并解析出 ${d.tables.length} 张表，报文已放进上方文本框，可再手动调整`);
          }}
        />
      </Section>
    </div>
  );
}

/* ---------------- 合并冲突面板 ---------------- */

const FIELD_LABEL: Record<string, string> = {
  tableComment: '表注释', comment: '字段注释', type: '类型', nullable: '可空', pk: '主键', default: '默认值',
};

export function MergePanel(p: {
  conflicts: MergeConflict[];
  resolutions: Record<string, 'base' | 'incoming'>;
  setResolutions: (r: Record<string, 'base' | 'incoming'>) => void;
  sourceName: string;
  stats: { tablesAdded: number; columnsAdded: number; tablesMatched: number };
  onApply: () => void;
  onCancel: () => void;
}) {
  /** 冲突值展示：空字符串不要显示成两个引号，避免原值/新值看起来一样 */
  const val = (v?: string | null) => {
    const s = String(v ?? '');
    if (!s) return <span class="muted">空</span>;
    if (s === "''" || s === '""') return <span class="muted">空字符串</span>;
    return s;
  };
  // 几千条冲突不能一次性渲染（每个 select 都是 DOM），分页保证 webview 不卡死
  const PAGE_SIZE = 200;
  const pageCount = Math.max(1, Math.ceil(p.conflicts.length / PAGE_SIZE));
  const [page, setPage] = useState(0);
  useEffect(() => { setPage(0); }, [p.conflicts.length]);
  const curPage = Math.min(page, pageCount - 1);
  const shown = p.conflicts.slice(curPage * PAGE_SIZE, (curPage + 1) * PAGE_SIZE);
  const set = (id: string, v: 'base' | 'incoming') => p.setResolutions({ ...p.resolutions, [id]: v });
  const all = (v: 'base' | 'incoming') => {
    const r: Record<string, 'base' | 'incoming'> = {};
    for (const c of p.conflicts) r[c.id] = v;
    p.setResolutions(r);
  };
  return (
    <Section title={`合并冲突（${p.conflicts.length}）· 来源：${p.sourceName}`}>
      <div class="small muted" style="margin-bottom:8px">
        新增 {p.stats.tablesAdded} 张表 / {p.stats.columnsAdded} 个字段，匹配上 {p.stats.tablesMatched} 张表。
        以下差异默认保留原值，请逐条选择或批量处理：
      </div>
      <div class="toolbar" style="margin-bottom:8px;flex-wrap:wrap">
        <Btn onClick={() => all('base')}>全部保留原值</Btn>
        <Btn onClick={() => all('incoming')}>全部采用新值</Btn>
        <Btn primary onClick={p.onApply}>应用并合并</Btn>
        <Btn onClick={p.onCancel}>取消本次导入</Btn>
        <span class="grow" />
        <span class="small muted">共 {p.conflicts.length} 条 · 第 {curPage + 1}/{pageCount} 页（每页 {PAGE_SIZE} 条）</span>
        <Btn onClick={() => setPage(Math.max(0, curPage - 1))} disabled={curPage === 0}>上一页</Btn>
        <Btn onClick={() => setPage(Math.min(pageCount - 1, curPage + 1))} disabled={curPage >= pageCount - 1}>下一页</Btn>
      </div>
      <div class="merge-table-wrap">
        <table class="tbl">
          <thead><tr><th>表</th><th>字段</th><th>项</th><th>原值</th><th>新值</th><th>选择</th></tr></thead>
          <tbody>
            {shown.map((c) => (
              <tr>
                <td class="mono">{c.table}</td>
                <td class="mono">{c.column || '（表级）'}</td>
                <td>{FIELD_LABEL[c.field] || c.field}</td>
                <td>{val(c.baseValue)}</td>
                <td>
                  {val(c.incomingValue)}
                  {c.incomingSourceName && <div class="small muted">{c.incomingSourceName}</div>}
                </td>
                <td>
                  <select value={p.resolutions[c.id] ?? 'base'} onInput={(e) => set(c.id, (e.target as HTMLSelectElement).value as 'base' | 'incoming')}>
                    <option value="base">保留原值</option>
                    <option value="incoming">采用新值</option>
                  </select>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Section>
  );
}


/* ---------------- 项目连接配置 ---------------- */

const DB_LABEL: Record<string, string> = { mysql: 'MySQL', postgres: 'PostgreSQL', mssql: 'SQL Server', oracle: 'Oracle' };

function Field(p: { label: string; children: any; hint?: string }) {
  return (
    <label class="row" style="gap:6px; margin-bottom:6px">
      <span style="width:110px; flex:none" class="small">{p.label}</span>
      {p.children}
      {p.hint && <span class="small muted">{p.hint}</span>}
    </label>
  );
}

/**
 * 项目级连接配置：数据库连接 + 金蝶连接。
 * 和密码/appSecret 有关的一律走 SecretStorage，输入框留空 = 不修改；
 * 左下角显示"已保存 xxx"表示该凭据已存在（不会回显明文）。
 */
export function ProjectConfigPanel(p: {
  projectName: string;
  projectId?: string | null;
  config: import('../../../core/messaging').ProjectConfig;
  /** 测试连接：返回可直接展示的结果文案 */
  onTest: (kind: 'db' | 'kingdee', cfg: import('../../../core/messaging').ProjectConfig, secrets: any, configId?: string) => Promise<string>;
  /** 全局 devToolbox.* 设置的值，仅用于"填充"按钮，运行时不参与取连接 */
  defaults?: { kingdee?: import('../../../core/messaging').KingdeeConnectionConfig };
  onSave: (cfg: import('../../../core/messaging').ProjectConfig, secrets: { dbPassword?: string; appSecret?: string; password?: string; dbConfigId?: string; kdConfigId?: string }) => Promise<void> | void;
}) {
  const newConfigId = () => `c_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
  const { confirm, confirmNode } = useConfirm();
  const { prompt, promptNode } = usePrompt();
  const [dbs, setDbs] = useState<any[]>((p.config.connections?.db || []).map((d: any) => ({ ...d })));
  const [kds, setKds] = useState<any[]>((p.config.connections?.kingdee || []).map((k: any) => ({ ...k })));
  const [selDb, setSelDb] = useState<string>(dbs[0]?.id ?? '');
  const [selKd, setSelKd] = useState<string>(kds[0]?.id ?? '');
  const [dbPwd, setDbPwd] = useState('');
  const [appSecret, setAppSecret] = useState('');
  const [pwd, setPwd] = useState('');
  const [msg, setMsg] = useState('');
  const [busy, setBusy] = useState(false);

  // 每条配置的凭据存在性（按 kind:configId 缓存，切项目重挂面板时重查）
  const [secMap, setSecMap] = useState<Record<string, string[]>>({});
  useEffect(() => {
    if (!p.projectId) return;
    let alive = true;
    (async () => {
      const m: Record<string, string[]> = {};
      for (const d of dbs) { try { m['db:' + d.id] = await host.projectReadSecretExists(p.projectId!, 'db', d.id); } catch { m['db:' + d.id] = []; } }
      for (const k of kds) { try { m['kingdee:' + k.id] = await host.projectReadSecretExists(p.projectId!, 'kingdee', k.id); } catch { m['kingdee:' + k.id] = []; } }
      if (alive) setSecMap(m);
    })();
    return () => { alive = false; };
  }, [p.projectId]);

  const db = dbs.find((x) => x.id === selDb) || dbs[0] || {};
  const kd = kds.find((x) => x.id === selKd) || kds[0] || {};
  const hasDbSecret = (secMap['db:' + db.id] ?? []).includes('password');
  const hasAppSecret = (secMap['kingdee:' + kd.id] ?? []).includes('appSecret');

  const [testMsg, setTestMsg] = useState('');
  const [testOk, setTestOk] = useState<boolean | null>(null);
  const [testing, setTesting] = useState<'db' | 'kingdee' | ''>('');
  const [showAdvanced, setShowAdvanced] = useState(false);

  const setList = (setter: any, list: any[], id: string, patch: any) => setter(list.map((x) => (x.id === id ? { ...x, ...patch } : x)));
  const onDbField = (k: string, v: any) => {
    const patch: any = { [k]: v };
    // 自动命名的配置随主机变化（用户重命名过 autoName=false 则不动）
    if (db.autoName !== false && (k === 'host' || k === 'database')) {
      const host = k === 'host' ? String(v || '').trim() : String(db.host || '').trim();
      const database = k === 'database' ? String(v || '').trim() : String(db.database || '').trim();
      if (host || database) patch.name = host || database;
    }
    setList(setDbs, dbs, db.id, patch);
  };
  const onKdField = (k: string, v: any) => setList(setKds, kds, kd.id, { [k]: v });

  const addDb = () => { const id = newConfigId(); setDbs([...dbs, { id, name: `数据库 ${dbs.length + 1}`, autoName: true, client: 'mysql', port: 3306 }]); setSelDb(id); };
  const delDb = (id: string) => { const next = dbs.filter((x) => x.id !== id); setDbs(next); if (selDb === id) setSelDb(next[0]?.id ?? ''); };
  const renameDb = async (id: string) => { const cur = dbs.find((x) => x.id === id); const n = await prompt('重命名数据库配置', cur?.name || ''); if (n && n.trim()) setList(setDbs, dbs, id, { name: n.trim(), autoName: false }); };

  const DEFAULT_PORTS: Record<string, number> = { mysql: 3306, postgres: 5432, mssql: 1433, oracle: 1521 };
  const onClientChange = (v: string) => {
    const prev = DEFAULT_PORTS[db.client]; const cur = Number(db.port);
    const patch: any = { client: v };
    if (!cur || (prev && cur === prev)) patch.port = DEFAULT_PORTS[v];
    onDbField('client', v); if (patch.port) setList(setDbs, dbs, db.id, { client: v, port: patch.port });
  };

  const addKd = () => { const id = newConfigId(); setKds([...kds, { id, name: `金蝶 ${kds.length + 1}`, argStyle: 'named', lcid: 2052 }]); setSelKd(id); };
  const delKd = (id: string) => { const next = kds.filter((x) => x.id !== id); setKds(next); if (selKd === id) setSelKd(next[0]?.id ?? ''); };
  const renameKd = async (id: string) => { const cur = kds.find((x) => x.id === id); const n = await prompt('重命名金蝶配置', cur?.name || ''); if (n && n.trim()) setList(setKds, kds, id, { name: n.trim() }); };

  const buildConfig = (): import('../../../core/messaging').ProjectConfig => ({
    connections: {
      db: dbs.map((d) => ({ id: d.id, name: d.name, autoName: d.autoName !== false, client: d.client, host: d.host, port: Number(d.port) || undefined, user: d.user, database: d.database })),
      kingdee: kds.map((k) => ({ id: k.id, name: k.name, baseUrl: k.baseUrl, dbId: k.dbId, appId: k.appId, user: k.user, lcid: Number(k.lcid) || undefined, loginPath: k.loginPath, metadataPath: k.metadataPath, argStyle: k.argStyle, extraHeaders: k.extraHeaders })),
    },
  });

  const runTest = async (kind: 'db' | 'kingdee') => {
    setTesting(kind); setTestMsg(kind === 'db' ? '正在连接数据库…' : '正在登录金蝶并校验接口…'); setTestOk(null);
    try {
      const cfgId = kind === 'db' ? db.id : kd.id;
      const out = await p.onTest(kind, buildConfig(), { dbPassword: dbPwd || undefined, appSecret: appSecret || undefined, password: pwd || undefined }, cfgId);
      setTestOk(!/^✗/.test(out));
      setTestMsg((kind === 'db' ? '[SQL] ' : '[金蝶] ') + out);
      if (p.projectId) {
        const keys = await host.projectReadSecretExists(p.projectId, kind, cfgId).catch(() => [] as string[]);
        setSecMap({ ...secMap, [`${kind}:${cfgId}`]: keys });
      }
      setDbPwd(''); setAppSecret(''); setPwd('');
    } catch (e: any) {
      setTestOk(false);
      setTestMsg(`✗ ${e?.message || e}`);
    }
    setTesting('');
  };

  const restoreDefaultPaths = () => {
    onKdField('loginPath', ''); onKdField('metadataPath', '');
    setTestMsg('已清空登录/元数据路径，保存后将使用官方默认接口');
    setTestOk(true);
  };

  /** 把旧版全局设置一次性带进当前金蝶配置（严格模式下运行时仍只读项目配置） */
  const fillFromGlobal = () => {
    const g = p.defaults?.kingdee;
    if (!g || Object.keys(g).length === 0) { setMsg('全局设置里没有金蝶配置可填充'); return; }
    setKds(kds.map((x) => (x.id === kd.id ? { ...x, ...JSON.parse(JSON.stringify(g)), id: x.id, name: x.name } : x)));
    setMsg('已从全局设置填充到当前金蝶配置，确认无误后点保存');
  };

  const save = async () => {
    setBusy(true); setMsg('');
    try {
      await p.onSave(buildConfig(), { dbPassword: dbPwd || undefined, appSecret: appSecret || undefined, password: pwd || undefined, dbConfigId: db.id, kdConfigId: kd.id });
      setDbPwd(''); setAppSecret(''); setPwd('');
      setMsg('✓ 已保存到本项目（连接信息随项目走，切换项目自动切换）');
    } catch (e: any) { setMsg(`✗ ${e?.message || e}`); }
    setBusy(false);
  };


  return (
    <div>
      <Section title={`项目「${p.projectName}」的连接配置`}>
        <div class="small muted" style="margin-bottom:8px">
          一个项目可配<b>多条数据库 / 多条金蝶</b>连接；连接信息存项目目录 config.json，密码/appSecret 存凭据库且<b>按项目+配置隔离</b>；
          导出项目包会带走连接配置但<b>不带密码</b>。没配连接的项目只能用离线方式（PDM / SQL / JSON / 粘贴报文）维护字典。
        </div>

        <div class="row" style="justify-content:space-between; align-items:center; margin:10px 0 6px">
          <span style="font-weight:600">数据库连接（{dbs.length}）</span>
          <Btn onClick={addDb}>+ 新增数据库</Btn>
        </div>
        {dbs.length === 0 && <div class="small muted" style="margin-bottom:8px">暂无数据库配置，点右上「+ 新增数据库」。</div>}
        {dbs.length > 0 && (
          <div>
            <div class="row" style="flex-wrap:wrap; gap:6px; margin-bottom:8px">
              {dbs.map((d) => (
                <span key={d.id} class={`badge${d.id === db.id ? ' info' : ''}`} style="cursor:pointer" onClick={() => setSelDb(d.id)} title={d.name}>{d.name || '未命名'}</span>
              ))}
              <a class="link small" href="#" onClick={(e) => { e.preventDefault(); renameDb(db.id); }}>重命名</a>
              <a class="link small" href="#" onClick={async (e) => { e.preventDefault(); if (await confirm(`删除数据库配置「${db.name}」？`)) delDb(db.id); }}>删除</a>
            </div>
            <Field label="类型">
              <select value={db.client ?? ''} onInput={(e: any) => onClientChange(e.target.value)}>
                <option value="">（未选择）</option>
                {Object.entries(DB_LABEL).map(([k, v]) => <option value={k}>{v}</option>)}
              </select>
            </Field>
            <Field label="主机 / 端口">
              <input type="text" style="width:150px" placeholder="127.0.0.1" value={db.host ?? ''} onInput={(e: any) => onDbField('host', e.target.value)} />
              <input type="number" style="width:80px" placeholder={String(DEFAULT_PORTS[db.client] ?? 3306)} value={db.port ?? ''} onInput={(e: any) => onDbField('port', e.target.value)} />
            </Field>
            <Field label="用户名 / 库名">
              <input type="text" style="width:120px" placeholder="user" value={db.user ?? ''} onInput={(e: any) => onDbField('user', e.target.value)} />
              <input type="text" style="width:130px" placeholder="database" value={db.database ?? ''} onInput={(e: any) => onDbField('database', e.target.value)} />
            </Field>
            <Field label="密码" hint={hasDbSecret ? '已保存（留空则不修改）' : '未保存'}>
              <input type="password" style="width:150px" placeholder={hasDbSecret ? '••••••（留空=不修改）' : 'password'} value={dbPwd} onInput={(e: any) => setDbPwd(e.target.value)} />
            </Field>
          </div>
        )}

        <div class="row" style="justify-content:space-between; align-items:center; margin:14px 0 6px">
          <span style="font-weight:600">金蝶云星空连接（{kds.length}）</span>
          <Btn onClick={addKd}>+ 新增金蝶</Btn>
        </div>
        {kds.length === 0 && <div class="small muted" style="margin-bottom:8px">暂无金蝶配置，点右上「+ 新增金蝶」。</div>}
        {kds.length > 0 && (
          <div>
            <div class="row" style="flex-wrap:wrap; gap:6px; margin-bottom:8px">
              {kds.map((k) => (
                <span key={k.id} class={`badge${k.id === kd.id ? ' info' : ''}`} style="cursor:pointer" onClick={() => setSelKd(k.id)} title={k.name}>{k.name || '未命名'}</span>
              ))}
              <a class="link small" href="#" onClick={(e) => { e.preventDefault(); renameKd(kd.id); }}>重命名</a>
              <a class="link small" href="#" onClick={async (e) => { e.preventDefault(); if (await confirm(`删除金蝶配置「${kd.name}」？`)) delKd(kd.id); }}>删除</a>
            </div>
            <Field label="站点地址">
              <input type="text" style="width:260px" placeholder="http://server/k3cloud" value={kd.baseUrl ?? ''} onInput={(e: any) => onKdField('baseUrl', e.target.value)} />
            </Field>
            <Field label="数据中心ID / AppId">
              <input type="text" style="width:140px" placeholder="acctID / dbId" value={kd.dbId ?? ''} onInput={(e: any) => onKdField('dbId', e.target.value)} />
              <input type="text" style="width:140px" placeholder="appId（可选）" value={kd.appId ?? ''} onInput={(e: any) => onKdField('appId', e.target.value)} />
            </Field>
            <Field label="登录用户 / lcid">
              <input type="text" style="width:140px" placeholder="用户名" value={kd.user ?? ''} onInput={(e: any) => onKdField('user', e.target.value)} />
              <input type="number" style="width:80px" placeholder="2052" value={kd.lcid ?? ''} onInput={(e: any) => onKdField('lcid', e.target.value)} />
            </Field>
            <Field label="appSecret" hint={hasAppSecret ? '已保存（留空则不修改）' : '未保存'}>
              <input type="password" style="width:150px" placeholder={hasAppSecret ? '••••••（留空=不修改）' : 'appSecret'} value={appSecret} onInput={(e: any) => setAppSecret(e.target.value)} />
            </Field>
            <Field label="登录密码" hint="WebAPI 直连登录用">
              <input type="password" style="width:150px" placeholder="登录密码" value={pwd} onInput={(e: any) => setPwd(e.target.value)} />
            </Field>
            <Field label="参数风格">
              <select value={kd.argStyle ?? 'named'} onInput={(e: any) => onKdField('argStyle', e.target.value)}>
                <option value="named">named（官方 FormId 对象）</option>
                <option value="parameters">parameters（数组）</option>
              </select>
            </Field>
            <div style="margin-top:8px">
              <a class="link small" href="#" onClick={(e) => { e.preventDefault(); setShowAdvanced(!showAdvanced); }}>
                {showAdvanced ? '收起高级参数 ▴' : '高级参数（接口路径 / 附加请求头）▾'}
              </a>
            </div>
            {showAdvanced && (
              <div class="col" style="margin-top:6px; padding-left:4px; border-left:2px solid var(--vscode-panel-border)">
                <Field label="登录接口路径" hint="留空用官方 AuthService.ValidateUser">
                  <input type="text" style="width:100%" placeholder="Kingdee.BOS.WebApi.ServicesStub.AuthService.ValidateUser.common.kdsvc" value={kd.loginPath ?? ''} onInput={(e: any) => onKdField('loginPath', e.target.value)} />
                </Field>
                <Field label="元数据接口路径" hint="留空用官方 QueryBusinessInfo">
                  <input type="text" style="width:100%" placeholder="Kingdee.BOS.WebApi.ServicesStub.DynamicFormService.QueryBusinessInfo.common.kdsvc" value={kd.metadataPath ?? ''} onInput={(e: any) => onKdField('metadataPath', e.target.value)} />
                </Field>
                <Field label="附加请求头" hint='JSON，如 {"Key":"xxx"}'>
                  <input type="text" style="width:100%" placeholder='{"Key":"xxx"}' value={kd.extraHeaders ?? ''} onInput={(e: any) => onKdField('extraHeaders', e.target.value)} />
                </Field>
                <Btn onClick={restoreDefaultPaths}>恢复默认接口路径</Btn>
              </div>
            )}
          </div>
        )}
        <div class="row" style="margin-top:10px">
          <Btn primary onClick={save} disabled={busy}>{busy ? '保存中…' : '保存到此项目'}</Btn>
          <Btn onClick={fillFromGlobal} disabled={kds.length === 0} title="把旧版 devToolbox.kingdee.* 全局设置带进当前金蝶配置">从全局设置填充</Btn>
          <Btn onClick={() => runTest('db')} disabled={testing !== '' || dbs.length === 0} title="用当前数据库配置试连一次">
            {testing === 'db' ? '测试中…' : '测试 SQL 连接'}
          </Btn>
          <Btn onClick={() => runTest('kingdee')} disabled={testing !== '' || kds.length === 0} title="用当前金蝶配置登录一次并校验接口可用">
            {testing === 'kingdee' ? '测试中…' : '测试 WebAPI 配置'}
          </Btn>
          {msg && <span class="small mono">{msg}</span>}
        </div>
        {testMsg && (
          <div
            class="small mono"
            style={`margin-top:8px; padding:6px 8px; border-radius:4px; white-space:pre-wrap; word-break:break-all;
              background:var(--vscode-textBlockQuote-background);
              border-left:3px solid ${testOk === false ? 'var(--vscode-errorForeground, #c00)' : 'var(--vscode-testing-iconPassed, #2ea043)'}`}
          >
            {testMsg}
          </div>
        )}
      </Section>
      {confirmNode}
      {promptNode}
    </div>
  );
}


/* ---------------- 表列表：虚拟滚动 + 筛选 ---------------- */

const ROW_H = 24; // 行高固定，才能用 scrollTop 直接算可视区间

export type TableFilter = 'all' | 'noComment' | 'noPk' | 'changed' | `kind:${string}`;
export type TableSort = 'name' | 'table' | 'columns';

export function filterLabel(f: TableFilter, sources: any[]): string {
  if (f === 'all') return '全部表';
  if (f === 'noComment') return '缺中文注释';
  if (f === 'noPk') return '缺主键';
  if (f === 'changed') return '有变更标记';
  const kind = String(f).slice(5);
  const s = sources.find((x) => x.kind === kind);
  return `来源：${s?.name || kind}`;
}

function matchFilter(t: any, f: TableFilter): boolean {
  switch (f) {
    case 'noComment': return !(t.comment || t.code);
    case 'noPk': return !t.columns.some((c: any) => c.pk);
    case 'changed': return !!t.changeTag;
    case 'all': return true;
    default: {
      const kind = String(f).slice(5);
      return (t.origin?.kind || 'unknown') === kind;
    }
  }
}

/**
 * 左栏表列表：只显示表名（不再就地展开字段，字段看右侧详情），
 * 用固定行高做虚拟滚动，1 万张表也只渲染可视区的几十行。
 */
export function TableList(p: {
  /** 整个字典对象：供扁平搜索索引使用（索引按对象缓存，dict 变了自动重建） */
  dict: any;
  tables: any[];
  sources?: any[];
  selected?: string;
  onSelect: (name: string) => void;
  /** 输入框即时值（受控），每次都立即回显，避免防抖期间被旧值覆盖 */
  keyword: string;
  /** 防抖后的搜索值：真正参与过滤；缺省用 keyword */
  activeKeyword?: string;
  onKeyword: (v: string) => void;
  maxHits?: number;
}) {
  const [filter, setFilter] = useState<TableFilter>('all');
  const [sortBy, setSortBy] = useState<TableSort>('name');
  const [scrollTop, setScrollTop] = useState(0);
  const [viewH, setViewH] = useState(600);
  const listRef = useRef<HTMLDivElement | null>(null);
  const sources = p.sources || [];
  const kw = (p.activeKeyword ?? p.keyword ?? '').trim().toLowerCase();

  // 中文名按拼音排序（numeric 让 F2 排在 F10 前）；切筛选/排序/关键字时回到顶部
  const collator = useMemo(() => new Intl.Collator('zh-CN', { numeric: true, sensitivity: 'base' }), []);
  useEffect(() => {
    setScrollTop(0);
    if (listRef.current) listRef.current.scrollTop = 0;
  }, [filter, sortBy, kw]);

  // 关键字优先：命中列的表排在前面，仍然是"表"级别的结果（不展开字段）
  const tableByName = useMemo(() => {
    const m = new Map<string, any>();
    for (const t of p.tables) m.set((t.name || '').toLowerCase(), t);
    return m;
  }, [p.tables]);

  // 关键字优先：命中列的表排在前面，仍然是"表"级别的结果（不展开字段）
  const hitNames = useMemo(() => (kw ? tablesMatching(p.dict, kw) : []), [kw, p.dict]);

  const list = useMemo(
    () => (kw
      ? hitNames.map((n: string) => tableByName.get(n.toLowerCase())).filter(Boolean) as any[]
      : p.tables.filter((t) => matchFilter(t, filter))),
    [kw, hitNames, tableByName, p.tables, filter],
  );

  // 默认按名称（中文名，缺中文名时用表名）排序；也可切表名 / 字段数
  const sorted = useMemo(() => {
    const labelOf = (t: any) => String(t.code || t.comment || '').trim();
    const arr = [...list];
    arr.sort((a, b) => {
      if (sortBy === 'columns') {
        return (b.columns?.length || 0) - (a.columns?.length || 0) || collator.compare(String(a.name || ''), String(b.name || ''));
      }
      if (sortBy === 'table') return collator.compare(String(a.name || ''), String(b.name || ''));
      // 有中文名的排前面，组内按拼音；无中文名的按表名排在后面
      const la = labelOf(a);
      const lb = labelOf(b);
      if (!la !== !lb) return la ? -1 : 1;
      return collator.compare(la || String(a.name || ''), lb || String(b.name || '')) || collator.compare(String(a.name || ''), String(b.name || ''));
    });
    return arr;
  }, [list, sortBy, collator]);

  const capped = useMemo(() => (kw ? sorted.slice(0, p.maxHits ?? 200) : sorted), [kw, sorted, p.maxHits]);
  const total = kw ? sorted.length : capped.length;

  const start = Math.max(0, Math.floor(scrollTop / ROW_H) - 4);
  const end = Math.min(capped.length, Math.ceil((scrollTop + viewH) / ROW_H) + 4);
  const slice = capped.slice(start, end);

  const kinds = useMemo(() => [...new Set(p.tables.map((t) => t.origin?.kind || 'unknown'))], [p.tables]);

  /** 把某一项滚动到可视区（键盘切换/外键跳转都用） */
  const scrollToIndex = (idx: number) => {
    const el = listRef.current;
    if (!el || idx < 0) return;
    const top = idx * ROW_H;
    const bottom = top + ROW_H;
    if (top < el.scrollTop) el.scrollTop = top;
    else if (bottom > el.scrollTop + el.clientHeight) el.scrollTop = bottom - el.clientHeight;
  };

  // 滚动事件用 rAF 合并，避免 1 万张表时每个 scroll 都触发一次 React 重渲染
  const rafRef = useRef(0);
  const scrollInfoRef = useRef({ top: 0, h: viewH });
  const onListScroll = (e: any) => {
    const el = e.currentTarget as HTMLDivElement;
    scrollInfoRef.current = { top: el.scrollTop, h: el.clientHeight || viewH };
    if (rafRef.current) return;
    rafRef.current = requestAnimationFrame(() => {
      rafRef.current = 0;
      setScrollTop(scrollInfoRef.current.top);
      setViewH(scrollInfoRef.current.h);
    });
  };
  useEffect(() => () => { if (rafRef.current) cancelAnimationFrame(rafRef.current); }, []);

  const moveSelection = (delta: number) => {
    if (!capped.length) return;
    const idx = capped.findIndex((t: any) => t.name === p.selected);
    const next = idx < 0
      ? (delta >= 0 ? 0 : capped.length - 1)
      : Math.max(0, Math.min(capped.length - 1, idx + delta));
    const t = capped[next];
    if (!t) return;
    p.onSelect(t.name);
    scrollToIndex(next);
  };

  const onListKeyDown = (e: any) => {
    const page = Math.max(1, Math.floor((listRef.current?.clientHeight || viewH) / ROW_H) - 1);
    if (e.key === 'ArrowDown') { e.preventDefault(); moveSelection(1); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); moveSelection(-1); }
    else if (e.key === 'PageDown') { e.preventDefault(); moveSelection(page); }
    else if (e.key === 'PageUp') { e.preventDefault(); moveSelection(-page); }
    else if (e.key === 'Home') { e.preventDefault(); moveSelection(-capped.length); }
    else if (e.key === 'End') { e.preventDefault(); moveSelection(capped.length); }
  };

  // 选中项变化（键盘/外键跳转/搜索）时，保证它在可视区
  useEffect(() => {
    const idx = capped.findIndex((t: any) => t.name === p.selected);
    if (idx >= 0) scrollToIndex(idx);
  }, [p.selected, capped]);

  return (
    <div class="left" style="display:flex; flex-direction:column; min-height:0; overflow:hidden">
      <div class="row" style="margin-bottom:6px; flex:none">
        <input
          type="text"
          class="mono"
          style="flex:1; min-width:0"
          placeholder="搜索表名/中文名/字段名…"
          value={p.keyword}
          onInput={(e: any) => p.onKeyword(e.target.value)}
          onKeyDown={(e: any) => {
            // 搜索框里直接按 ↑/↓ 也能切表，不必先用鼠标点左栏
            if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
              e.preventDefault();
              listRef.current?.focus();
              moveSelection(e.key === 'ArrowDown' ? 1 : -1);
            }
          }}
        />
      </div>
      <div class="row" style="margin-bottom:6px; flex:none; gap:6px">
        <select value={filter} disabled={!!kw} style="flex:1; min-width:0" onInput={(e: any) => setFilter(e.target.value as TableFilter)} title="按条件筛选表（有搜索关键字时以搜索结果为准）">
          <option value="all">全部表</option>
          <option value="noComment">缺中文注释</option>
          <option value="noPk">缺主键</option>
          <option value="changed">有变更标记</option>
          {kinds.map((k) => <option value={`kind:${k}`}>{filterLabel(`kind:${k}` as TableFilter, sources)}</option>)}
        </select>
        <select value={sortBy} style="flex:none" onInput={(e: any) => setSortBy(e.target.value as TableSort)} title="列表排序">
          <option value="name">按名称</option>
          <option value="table">按表名</option>
          <option value="columns">按字段数</option>
        </select>
        <span class="small muted" style="flex:none">{total} 张</span>
      </div>

      <div
        class="vlist"
        ref={listRef}
        tabIndex={0}
        title="↑/↓ 切换表，PageUp/PageDown 翻页"
        onKeyDown={onListKeyDown}
        onScroll={onListScroll}
      >
        {capped.length === 0 && <div class="small muted" style="padding:8px">没有匹配的表</div>}
        <div class="vlist-inner" style={`height:${capped.length * ROW_H}px`}>
          {slice.map((t, i) => (
            <div
              key={t.name}
              class={`vrow${p.selected === t.name ? ' active' : ''}`}
              style={`top:${(start + i) * ROW_H}px`}
              onClick={() => { listRef.current?.focus(); p.onSelect(t.name); }}
              title={`${t.name}${t.code ? ` · ${t.code}` : ''}（${t.columns.length} 字段）`}
            >
              <span class="vname mono">{t.name}</span>
              {t.code && <span class="vcode small">{t.code}</span>}
              <span class="small muted" style="margin-left:auto; flex:none">{t.columns.length}</span>
            </div>
          ))}
        </div>
      </div>

      {kw && sorted.length > capped.length && (
        <div class="small muted" style="padding:4px 2px; flex:none">命中 {sorted.length} 张，仅列出前 {capped.length} 张，请用更精确的关键字</div>
      )}
    </div>
  );
}

/* ---------------- 跨项目比对 ---------------- */

export function CrossProjectDiffPanel(p: {
  projects: any[];
  currentId: string;
  otherId: string;
  onPickOther: (id: string) => void;
  diff: { summary?: any; items?: any[] };
  loading?: boolean;
  onRun: () => void;
  onCopy: () => void;
}) {
  const s = p.diff?.summary;
  return (
    <Section title="跨项目比对">
      <div class="small muted" style="margin-bottom:8px">
        拿当前项目的字典，和另一个项目的字典逐表逐字段对比（表名不区分大小写）。
        常用于：客户 A 库 vs 客户 B 库、生产库 vs 测试库。
      </div>
      <div class="row" style="margin-bottom:8px">
        <span class="small" style="flex:none">对比对象</span>
        <select value={p.otherId} onInput={(e: any) => p.onPickOther(e.target.value)} title="选择要与当前项目比对的项目">
          <option value="">（选择另一个项目）</option>
          {p.projects.filter((x) => x.id !== p.currentId).map((x) => <option value={x.id}>{x.name}</option>)}
        </select>
        <Btn primary onClick={p.onRun} disabled={!p.otherId || p.loading}>
          {p.loading ? '比对中…' : '开始比对'}
        </Btn>
        {s && <Btn onClick={p.onCopy}>复制差异报告(MD)</Btn>}
      </div>

      {!s && <div class="small muted">选择另一个项目后点「开始比对」。</div>}
      {s && (
        <>
          <div class="row" style="margin:6px 0">
            <span class="badge added">仅当前项目有 {s.onlyCurrent ?? s.removed}</span>
            <span class="badge deleted">仅对方项目有 {s.onlyOther ?? s.added}</span>
            <span class="badge modified">有差异 {s.modified}</span>
            <span class="badge">合计 {s.total}</span>
          </div>
          <table class="tbl">
            <thead><tr><th>表</th><th>对象</th><th>类型</th><th>变化</th></tr></thead>
            <tbody>
              {(p.diff.items || []).slice(0, 200).map((it: any, i: number) => (
                <tr key={i}>
                  <td class="mono">{it.table}</td>
                  <td class="mono">{it.object}</td>
                  <td><span class={`badge ${it.kind === 'added' ? 'ok' : it.kind === 'removed' ? 'err' : 'warn'}`}>{it.kind}</span></td>
                  <td class="small">{(it.changes || []).map((c: any) => `${c.prop}: ${c.from} → ${c.to}`).join('；')}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}
    </Section>
  );
}
