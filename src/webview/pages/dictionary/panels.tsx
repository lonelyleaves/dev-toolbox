import { h } from 'preact';
import { useState } from 'preact/hooks';
import { Btn, Section } from '../../components';
import { ProjectMeta } from '../../../core/messaging';
import { host } from '../../bridge';
import { parseKingdeeMetadata } from '../../../dictionary/kingdee';
import { DictionaryModel, DictSource, SourceKind } from '../../../dictionary/model';
import { MergeConflict } from '../../../dictionary/merge';

const KIND_LABEL: Record<SourceKind, string> = {
  pdm: 'PDM', ddl: 'DDL', md: 'Markdown', excel: 'Excel', db: '数据库', kingdee: '金蝶', dtcat: '字典文件',
};

export function sourceKindLabel(k: SourceKind): string {
  return KIND_LABEL[k] || k;
}

/* ---------------- 项目栏 ---------------- */

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
}) {
  const [name, setName] = useState('');
  const cur = p.projects.find((x) => x.id === p.currentId);
  return (
    <div class="toolbar" style="flex-wrap:wrap; gap:8px; margin-bottom:10px">
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
      <Btn onClick={() => { const n = cur ? prompt('重命名项目', cur.name) : null; if (n && n.trim()) p.onRename(n.trim()); }}>重命名</Btn>
      <Btn onClick={p.onImport}>导入项目包</Btn>
      <Btn onClick={p.onExport}>导出项目包</Btn>
      <Btn onClick={() => { if (cur && confirm(`清空项目「${cur.name}」的所有字典数据与来源？项目本身保留。`)) p.onClear(); }}>清空</Btn>
      <Btn onClick={() => { if (cur && confirm(`删除项目「${cur.name}」？该项目的字典数据将一并删除。`)) p.onDelete(); }}>删除</Btn>
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
}) {
  const sources = p.dict.sources || [];
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
                <td class="small">{new Date(s.importedAt).toLocaleString('zh-CN')}</td>
                <td>{s.priority}</td>
                <td>{s.enabled ? '启用' : <span class="muted">已禁用</span>}</td>
                <td>
                  {s.path && <a class="link" href="#" onClick={(e) => { e.preventDefault(); p.onRefresh(s.id); }} title="按原路径重新解析该来源">刷新</a>}
                  {' '}
                  <a class="link" href="#" onClick={(e) => { e.preventDefault(); p.onToggle(s.id); }}>{s.enabled ? '禁用' : '启用'}</a>
                  {' '}
                  <a class="link" href="#" onClick={(e) => { e.preventDefault(); if (confirm(`移除来源「${s.name}」？该来源带来的表与字段会一并删除。`)) p.onRemove(s.id); }}>移除</a>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </Section>
      <div class="toolbar"><Btn primary onClick={p.onAdd}>+ 导入新来源</Btn></div>
    </div>
  );
}

/* ---------------- 金蝶云星空接入 ---------------- */

export function KingdeePanel(p: { onImport: (dict: any, name: string) => void }) {
  const [raw, setRaw] = useState('');
  const [formIds, setFormIds] = useState('');
  const [secret, setSecret] = useState('');
  const [pwd, setPwd] = useState('');
  const [msg, setMsg] = useState('');
  const [busy, setBusy] = useState(false);

  const doParse = () => {
    if (!raw.trim()) { setMsg('请先粘贴金蝶元数据或 WebAPI 返回报文'); return; }
    const d = parseKingdeeMetadata(raw, '金蝶元数据');
    if (!d.tables.length) { setMsg(`✗ ${d.importErrors[0]?.message || '未识别到表单/字段'}`); return; }
    p.onImport(d, '金蝶元数据');
    setMsg(`✓ 解析出 ${d.tables.length} 张表，已按合并规则并入`);
  };

  const doFetch = async () => {
    const ids = formIds.split(/[,，\s]+/).map((s) => s.trim()).filter(Boolean);
    if (!ids.length) { setMsg('请填写至少一个表单标识，如 BD_MATERIAL'); return; }
    setBusy(true);
    setMsg('正在登录并拉取元数据…');
    try {
      if (secret || pwd) await host.kingdeeSaveSecret(secret || undefined, pwd || undefined);
      const r = await host.kingdeeFetchMetadata(ids, secret || undefined, pwd || undefined);
      if (!r.ok) { setMsg(`✗ ${r.error}`); return; }
      setRaw(r.text || '');
      const d = parseKingdeeMetadata(r.text || '', '金蝶 ' + ids.join(','));
      if (!d.tables.length) {
        setMsg(`已取到报文但未能识别结构，可手动检查下方文本框后点"解析并入"。${d.importErrors[0]?.message || ''}`);
        return;
      }
      p.onImport(d, `金蝶 ${ids.join(',')}`);
      setMsg(`✓ 拉取并解析出 ${d.tables.length} 张表`);
    } catch (e: any) {
      setMsg(`✗ ${e?.message || e}`);
    } finally { setBusy(false); }
  };

  return (
    <div>
      <Section title="金蝶云星空 · 方式一：粘贴报文/元数据">
        <div class="small muted" style="margin-bottom:6px">
          把表单元数据（XML/JSON）或 WebAPI 返回的报文直接粘进来即可，不需要网络与账号。
          官方报文语义：Key=字段名、Name=中文标题、MustInput=1 → 必填、IsViewVisible=false → 界面已隐藏。
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
          接口地址、账套、应用 Id 在设置里配置（devToolbox.kingdee.*）；appSecret 与密码只存 VS Code 凭据库，不进项目文件。
        </div>
        <div class="toolbar" style="flex-wrap:wrap; gap:8px">
          <input type="text" placeholder="表单标识，逗号分隔，如 BD_MATERIAL,BD_CUSTOMER" style="flex:1 1 260px" value={formIds} onInput={(e) => setFormIds((e.target as HTMLInputElement).value)} />
          <input type="password" placeholder="appSecret" style="width:150px" value={secret} onInput={(e) => setSecret((e.target as HTMLInputElement).value)} />
          <input type="password" placeholder="登录密码" style="width:150px" value={pwd} onInput={(e) => setPwd((e.target as HTMLInputElement).value)} />
          <Btn primary onClick={doFetch} disabled={busy}>{busy ? '拉取中…' : '拉取元数据'}</Btn>
        </div>
        {msg && <div class="small" style="margin-top:6px">{msg}</div>}
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
      <div class="toolbar" style="margin-bottom:8px">
        <Btn onClick={() => all('base')}>全部保留原值</Btn>
        <Btn onClick={() => all('incoming')}>全部采用新值</Btn>
        <Btn primary onClick={p.onApply}>应用并合并</Btn>
        <Btn onClick={p.onCancel}>取消本次导入</Btn>
      </div>
      <table class="tbl">
        <thead><tr><th>表</th><th>字段</th><th>项</th><th>原值</th><th>新值</th><th>选择</th></tr></thead>
        <tbody>
          {p.conflicts.map((c) => (
            <tr>
              <td class="mono">{c.table}</td>
              <td class="mono">{c.column || '（表级）'}</td>
              <td>{FIELD_LABEL[c.field] || c.field}</td>
              <td>{String(c.baseValue ?? '') || <span class="muted">空</span>}</td>
              <td>{String(c.incomingValue ?? '') || <span class="muted">空</span>}</td>
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
    </Section>
  );
}
