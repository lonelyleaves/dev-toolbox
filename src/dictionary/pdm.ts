import { XMLParser } from 'fast-xml-parser';
import { parseXmlLight } from './pdm-xml';
import { DictionaryModel, TableDef, ColumnDef, ViewDef, ProcedureDef, SequenceDef, DomainDef, emptyDictionary } from './model';

/**
 * PowerDesigner .pdm (XML) 解析。
 *
 * 真实 PDM 结构要点（与简化样例不同，务必按此兼容）：
 * - 表挂在 Model 的 c:Tables 集合（部分旧版/导出物挂 c:Children），因此采用深度遍历收集所有 o:Table 节点
 * - 节点 id 属性为大写 Id（Id="o5"），引用占位节点形如 <o:Column Ref="o5"/>（只有 @_Ref，需排除避免误认）
 * - 列的 a:Code 为物理名、a:Name 为显示名；a:Mandatory=1 表示 NOT NULL；a:AutoRec=1 为自增
 * - 主键不在列上！由表下 c:Keys 的 o:Key（a:PrimaryKey=1）通过 c:Key.Columns 的列引用声明
 * - 外键为模型级 c:References 的 o:Reference：c:ParentTable/c:ChildTable + c:ReferenceJoinElements 列映射
 * - 逐表容错：单表失败记入 importErrors，不影响其他表
 */
export function parsePdm(xml: string): DictionaryModel {
  const dict = emptyDictionary('pdm-import', 'mysql');
  dict.meta = { source: 'pdm' };
  let root: any;
  try {
    // 轻量扫描器（自研）：单遍扫描，85MB 全库 PDM 从 400+ 秒降到数秒。
    // 实测依据见 docs/PITFALLS.md；解析异常时退回 fast-xml-parser 兜底
    root = parseXmlLight(xml);
    if (!root || typeof root !== 'object' || Object.keys(root).length === 0) throw new Error('空的 XML 文档');
  } catch (e: any) {
    try {
      const parser = new XMLParser({
        ignoreAttributes: false,
        attributeNamePrefix: '@_',
        parseTagValue: false,
        parseAttributeValue: false,
        trimValues: true,
        processEntities: false,
      });
      root = parser.parse(xml);
      if (!root || typeof root !== 'object') throw new Error('空的 XML 文档');
    } catch (e2: any) {
      dict.importErrors.push({ source: 'pdm', message: `XML 解析失败: ${e2?.message || e2}` });
      return dict;
    }
  }

  const tableNodes: any[] = [];
  const refNodes: any[] = [];
  const viewNodes: any[] = [];
  const procNodes: any[] = [];
  const seqNodes: any[] = [];
  const domainNodes: any[] = [];
  /** o:Shortcut：跨包/跨模型的快捷引用，带 a:Code/a:Name，会被 Reference 当作父表引用 */
  const shortcutNodes: any[] = [];
  const isPlaceholder = (v: any) => !v || typeof v !== 'object' || v['@_Ref'] !== undefined;
  walkDeep(root, (key, value) => {
    if (/(^|:)Table$/.test(key)) {
      for (const item of asArray(value)) if (!isPlaceholder(item)) tableNodes.push(item);
    } else if (/(^|:)Reference$/.test(key)) {
      for (const item of asArray(value)) if (!isPlaceholder(item)) refNodes.push(item);
    } else if (/(^|:)View$/.test(key)) {
      for (const item of asArray(value)) if (!isPlaceholder(item)) viewNodes.push(item);
    } else if (/(^|:)(Procedure|Method)$/.test(key)) {
      for (const item of asArray(value)) if (!isPlaceholder(item)) procNodes.push(item);
    } else if (/(^|:)Sequence$/.test(key)) {
      // 注意：标量属性（如 a:Sequence）会被 isPlaceholder 过滤，不会误收
      for (const item of asArray(value)) if (!isPlaceholder(item)) seqNodes.push(item);
    } else if (/(^|:)Domain$/.test(key)) {
      for (const item of asArray(value)) if (!isPlaceholder(item)) domainNodes.push(item);
    } else if (/(^|:)Shortcut$/.test(key)) {
      for (const item of asArray(value)) if (!isPlaceholder(item)) shortcutNodes.push(item);
    }
  });

  const tableById = new Map<string, string>();
  const columnById = new Map<string, { table: string; column: string }>();

  for (const t of tableNodes) {
    try {
      const id = str(t['@_Id'] ?? t['@_id']);
      const name = pick(t['a:Code'], t['a:Name']) || '';
      if (!name) throw new Error('表缺少名称: id=' + String(t['@_Id'] ?? t['@_id']) + ' keys=' + Object.keys(t).slice(0,8).join(','));
      if (id) tableById.set(id, name);
      const display = splitDisplay(pick(t['a:Name']), name);
      const table: TableDef = {
        name,
        code: display,
        // 金蝶 PDM 的 a:Comment 常为空，中文名就是事实上的注释；用清洗后的显示名兜底，避免重复
        comment: pick(t['a:Comment']) || display,
        creator: pick(t['a:Creator']) || undefined,
        modifier: pick(t['a:Modifier']) || undefined,
        columns: [],
        indexes: [],
        foreignKeys: [],
      };

      // 列：任意 *Columns 集合下的 o:Column（排除纯 Ref 占位节点）
      const colNodes: any[] = [];
      walkDeep(t['c:Columns'] ?? findCollection(t, /(^|:)Columns$/), (key, value) => {
        if (/(^|:)Column$/.test(key) && value && typeof value === 'object' && value['@_Ref'] === undefined) {
          colNodes.push(...asArray(value));
        }
      });
      for (const c of colNodes) {
        const colId = str(c['@_Id'] ?? c['@_id']);
        const colCode = pick(c['a:Code']) || '';   // 物理名（FPKID/FID…）
        const colName = pick(c['a:Name']) || '';   // 显示名（中文，如"主键""内码"）
        if (colId) columnById.set(colId, { table: name, column: colCode || colName });
        // 提取长度/精度：char 族用 Length，decimal 族用 Precision,Scale
        const dataType = String(pick(c['a:DataType']) || '');
        const len = pick(c['a:Length']);
        const prec = pick(c['a:Precision']);
        const scale = pick(c['a:Scale']);
        let length: string | undefined;
        if (/decimal|numeric/i.test(dataType) && prec) {
          length = scale ? `${prec},${scale}` : prec;
        } else if (len && len !== '0') {
          length = len;
        }
        // 与表保持一致的语义：name=物理名（参与 DDL/比对/检查），code=显示名（中文）
        // 修复前反了过来，导致导出的 DDL 字段名是中文、与真实库比对全部不匹配
        table.columns.push({
          name: colCode || colName,
          code: colName || undefined,
          type: String(pick(c['a:DataType']) || inferType(c)),
          length,
          nullable: !isTrue(c['a:Mandatory']),
          defaultValue: c['a:DefaultValue'] != null && c['a:DefaultValue'] !== '' ? decodeEntities(String(c['a:DefaultValue'])) : undefined,
          comment: pick(c['a:Comment']) || undefined,
          autoIncrement: isTrue(c['a:AutoRec']) || /autoincrement|identity|@/i.test(String(pick(c['a:ExtendedAttributeText']) || '')),
        });
      }

      // 主键：o:Key（a:PrimaryKey=1）→ c:Key.Columns 里的列引用
      const keyNodes: any[] = [];
      walkDeep(findCollection(t, /(^|:)Keys$/), (k, v) => {
        if (/(^|:)Key$/.test(k) && v && typeof v === 'object' && v['@_Ref'] === undefined) keyNodes.push(...asArray(v));
      });
      for (const k of keyNodes) {
        // 主键识别：标准 PDM 用 a:PrimaryKey=1；金蝶等导出物不带该标记，但约束名以 PK_/pk_ 开头
        const constraint = pick(k['a:ConstraintName'], k['a:Code'], k['a:Name']) || '';
        if (!isTrue(k['a:PrimaryKey']) && !/^pk_/i.test(constraint)) continue;
        const refIds: string[] = [];
        walkDeep(findCollection(k, /Columns$/), (_kk, vv) => {
          if (vv && typeof vv === 'object') {
            for (const item of asArray(vv)) {
              if (item && typeof item === 'object' && item['@_Ref']) refIds.push(String(item['@_Ref']));
            }
          }
        });
        for (const rid of refIds) {
          const colName = columnById.get(rid)?.column;
          // 同时匹配 code 和 name（大小写不敏感）
          const col = table.columns.find((c) => 
            c.code?.toLowerCase() === colName?.toLowerCase() || 
            c.name.toLowerCase() === colName?.toLowerCase()
          );
          if (col) col.pk = true;
        }
      }
      // 兼容：直接在列上标 PrimaryKey 的简化格式
      for (const c of colNodes) {
        if (isTrue(c['a:PrimaryKey'])) {
          const colCode = pick(c['a:Code']);
          const colName = pick(c['a:Name']) || colCode;
          // 同时匹配 code 和 name（大小写不敏感）
          const col = table.columns.find((x) => 
            x.code?.toLowerCase() === colCode?.toLowerCase() || 
            x.name.toLowerCase() === colName?.toLowerCase()
          );
          if (col) col.pk = true;
        }
      }

      // 索引
      const idxNodes: any[] = [];
      walkDeep(findCollection(t, /(^|:)Indexes$/), (k, v) => {
        if (/(^|:)Index$/.test(k) && v && typeof v === 'object' && v['@_Ref'] === undefined) idxNodes.push(...asArray(v));
      });
      for (const idx of idxNodes) {
        const cols: string[] = [];
        walkDeep(findCollection(idx, /Columns$/), (kk, vv) => {
          if (!/(^|:)IndexColumn$/.test(kk)) return;
          for (const ic of asArray(vv)) {
            if (!ic || typeof ic !== 'object') continue;
            const refs: string[] = [];
            walkDeep(ic, (k3, v3) => {
              if (/(^|:)Column$/.test(k3)) {
                for (const col of asArray(v3)) {
                  if (col && typeof col === 'object' && col['@_Ref']) refs.push(String(col['@_Ref']));
                }
              }
            });
            if (refs.length) cols.push(columnById.get(refs[0])?.column ?? '');
          }
        });
        table.indexes.push({
          name: pick(idx['a:Code'], idx['a:Name']) || 'index',
          unique: isTrue(idx['a:Unique']),
          columns: cols.filter(Boolean),
        });
      }

      dict.tables.push(table);
    } catch (e: any) {
      dict.importErrors.push({ source: `table#${t['@_Id'] ?? t['@_id'] ?? '?'}`, message: String(e?.message || e) });
    }
  }

  // 快捷方式（o:Shortcut）也参与 Id→表名 映射：
  // 实测金蝶 BD基础.pdm 有 5 条 Reference 的父表指向 Shortcut（如 o605→T_BD_STAFF），
  // 未纳入映射会导致这些外键被静默丢弃
  for (const s of shortcutNodes) {
    const id = str(s['@_Id'] ?? s['@_id']);
    const name = pick(s['a:Code'], s['a:Name']);
    if (id && name && !tableById.has(id)) tableById.set(id, name);
  }

  // 外键
  for (const r of refNodes) {
    try {
      const parentRef = findFirstRef(r, /(^|:)ParentTable$/);
      const childRef = findFirstRef(r, /(^|:)ChildTable$/);
      const parentName = parentRef && tableById.get(parentRef);
      const childName = childRef && tableById.get(childRef);
      // 以前这里静默 continue，真实文件里丢外键无从察觉 → 记入导入报告
      if (!parentName || !childName) {
        dict.importErrors.push({
          source: `reference#${r['@_Id'] ?? '?'}`,
          message: `外键跳过：${!parentName ? `父表 Ref=${parentRef || '无'}` : `子表 Ref=${childRef || '无'}`} 未解析到表名`,
        });
        continue;
      }
      const childTable = dict.tables.find((t) => t.name === childName);
      if (!childTable) continue;
      const joinNodes: any[] = [];
      walkDeep(r, (k, v) => {
        if (/(^|:)ReferenceJoin(Element)?$/.test(k)) {
          for (const item of asArray(v)) if (!isPlaceholder(item)) joinNodes.push(item);
        }
      });
      const columns: string[] = [];
      const refColumns: string[] = [];
      for (const j of joinNodes) {
        // 两种列映射写法：标准 ReferenceJoinElement(ChildColumnRef/ParentColumnRef)
        // 与金蝶导出物 ReferenceJoin(Object1=子表列 / Object2=父表列)
        let childRef = findFirstRef(j, /(^|:)ChildColumnRef$/) ?? findFirstRef(j, /(^|:)Object1$/);
        let parentRef = findFirstRef(j, /(^|:)ParentColumnRef$/) ?? findFirstRef(j, /(^|:)Object2$/);
        // 用列归属表智能纠正父子方向（兼容不同导出物 Object1/Object2 约定差异）
        if (childRef && parentRef && columnById.get(childRef)?.table !== childName && columnById.get(parentRef)?.table === childName) {
          ;[childRef, parentRef] = [parentRef, childRef];
        }
        if (childRef) columns.push(columnById.get(childRef)?.column ?? '');
        if (parentRef) refColumns.push(columnById.get(parentRef)?.column ?? '');
      }
      childTable.foreignKeys.push({
        name: pick(r['a:Code'], r['a:Name']) || `fk_${childName}_${parentName}`,
        columns: columns.filter(Boolean),
        refTable: parentName,
        refColumns: refColumns.filter(Boolean),
      });
    } catch (e: any) {
      dict.importErrors.push({ source: `reference#${r['@_Id'] ?? '?'}`, message: String(e?.message || e) });
    }
  }

  // 视图解析
  if (viewNodes.length > 0) {
    dict.views = [];
    for (const v of viewNodes) {
      try {
        const viewName = pick(v['a:Code'], v['a:Name']) || '';
        const viewDisplay = splitDisplay(pick(v['a:Name']), viewName);
        const view: ViewDef = {
          name: viewName,
          code: viewDisplay,
          comment: pick(v['a:Comment']) || viewDisplay,
          // 真实 PDM 用 a:View.SQLQuery（格式化前）/ a:TaggedSQLQuery（格式化后），
          // a:Select 仅少数导出物使用；此前只认 a:Select → 视图 SQL 全空
          definition: pick(v['a:View.SQLQuery'], v['a:TaggedSQLQuery'], v['a:Select']) || undefined,
          columns: [],
        };
        // 视图列：节点名是 o:ViewColumn（不是 o:Column），此前正则不匹配 → 视图列恒为 0
        const viewColNodes: any[] = [];
        walkDeep(findCollection(v, /(^|:)Columns$/), (key, value) => {
          if (/(^|:)(View)?Column$/.test(key) && value && typeof value === 'object' && value['@_Ref'] === undefined) {
            viewColNodes.push(...asArray(value));
          }
        });
        for (const c of viewColNodes) {
          view.columns.push({
            // 与表列同语义：name=物理名，code=显示名
            name: pick(c['a:Code']) || pick(c['a:Name']) || '',
            code: pick(c['a:Name']) || undefined,
            // 视图列通常不声明类型，留空比伪造 varchar 诚实
            type: String(pick(c['a:DataType']) || ''),
            comment: pick(c['a:Comment']) || undefined,
          });
        }
        if (view.name) dict.views.push(view);
      } catch (e: any) {
        dict.importErrors.push({ source: `view#${v['@_Id'] ?? '?'}`, message: String(e?.message || e) });
      }
    }
  }

  // 存储过程/函数解析
  if (procNodes.length > 0) {
    dict.procedures = [];
    for (const p of procNodes) {
      try {
        const proc: ProcedureDef = {
          name: pick(p['a:Code'], p['a:Name']) || '',
          code: pick(p['a:Name']) || undefined,
          comment: pick(p['a:Comment'], p['a:Name']) || undefined,
          returnType: pick(p['a:ReturnType']) || undefined,
          parameters: [],
          body: pick(p['a:Body']) || undefined,
        };
        // 参数
        const paramNodes: any[] = [];
        walkDeep(findCollection(p, /(^|:)Parameters$/), (key, value) => {
          if (/(^|:)Parameter$/.test(key) && value && typeof value === 'object' && value['@_Ref'] === undefined) {
            paramNodes.push(...asArray(value));
          }
        });
        for (const param of paramNodes) {
          proc.parameters.push({
            name: pick(param['a:Code'], param['a:Name']) || '',
            type: String(pick(param['a:DataType']) || 'varchar'),
            direction: (pick(param['a:Direction']) || 'IN').toUpperCase() as 'IN' | 'OUT' | 'INOUT',
            defaultValue: pick(param['a:DefaultValue']) || undefined,
          });
        }
        if (proc.name) dict.procedures.push(proc);
      } catch (e: any) {
        dict.importErrors.push({ source: `procedure#${p['@_Id'] ?? '?'}`, message: String(e?.message || e) });
      }
    }
  }

  // 序列解析（o:Sequence）
  // 【假设】不同 PowerDesigner 版本/导出物对序列数值的属性名不统一
  // （见过 a:StartValue/a:InitialValue、a:IncrementBy/a:Increment 两种写法），
  // 这里按候选名依次取值，取不到则留空，不会因属性名差异导致整条序列被丢弃
  if (seqNodes.length > 0) {
    dict.sequences = [];
    for (const s of seqNodes) {
      try {
        const seqName = pick(s['a:Code'], s['a:Name']) || '';
        const seqDisplay = splitDisplay(pick(s['a:Name']), seqName);
        const seq: SequenceDef = {
          name: seqName,
          code: seqDisplay,
          comment: pick(s['a:Comment']) || seqDisplay,
          start: pick(s['a:StartValue'], s['a:InitialValue']) || undefined,
          increment: pick(s['a:IncrementBy'], s['a:Increment']) || undefined,
          min: pick(s['a:MinValue'], s['a:Minimum']) || undefined,
          max: pick(s['a:MaxValue'], s['a:Maximum']) || undefined,
          current: pick(s['a:CurrentValue'], s['a:LastValue']) || undefined,
          cache: pick(s['a:Cache'], s['a:CacheSize']) || undefined,
          cycle: isTrue(s['a:Cycle']) || isTrue(s['a:CycleFlag']) || undefined,
        };
        if (seq.name) dict.sequences.push(seq);
      } catch (e: any) {
        dict.importErrors.push({ source: `sequence#${s['@_Id'] ?? '?'}`, message: String(e?.message || e) });
      }
    }
  }

  // 域定义解析
  if (domainNodes.length > 0) {
    dict.domains = [];
    for (const d of domainNodes) {
      try {
        const dataType = String(pick(d['a:DataType']) || '');
        const len = pick(d['a:Length']);
        const prec = pick(d['a:Precision']);
        const scale = pick(d['a:Scale']);
        const domainName = pick(d['a:Code'], d['a:Name']) || '';
        const domainDisplay = splitDisplay(pick(d['a:Name']), domainName);
        const domain: DomainDef = {
          name: domainName,
          code: domainDisplay,
          dataType,
          length: len && len !== '0' ? len : undefined,
          precision: prec || undefined,
          scale: scale || undefined,
          nullable: !isTrue(d['a:Mandatory']),
          defaultValue: pick(d['a:DefaultValue']) || undefined,
          comment: pick(d['a:Comment']) || domainDisplay,
          checkConstraint: pick(d['a:CheckConstraint']) || undefined,
        };
        if (domain.name) dict.domains.push(domain);
      } catch (e: any) {
        dict.importErrors.push({ source: `domain#${d['@_Id'] ?? '?'}`, message: String(e?.message || e) });
      }
    }
  }

  if (dict.tables.length === 0 && dict.importErrors.length === 0) {
    dict.importErrors.push({ source: 'pdm', message: '未找到任何 o:Table 节点，请确认这是 PowerDesigner 的 PDM（物理数据模型）文件而非 CDM/LDM' });
  }
  return dict;
}

/** 深度遍历对象树，对每个 key/value 调用 visit */
function walkDeep(node: any, visit: (key: string, value: any) => void) {
  if (Array.isArray(node)) {
    for (const n of node) walkDeep(n, visit);
    return;
  }
  if (node && typeof node === 'object') {
    for (const [k, v] of Object.entries(node)) {
      visit(k, v);
      walkDeep(v, visit);
    }
  }
}

/** 在父节点下找第一个 key 匹配的集合（不区分层级深浅，取最浅者） */
function findCollection(node: any, keyPattern: RegExp): any {
  if (!node || typeof node !== 'object') return undefined;
  for (const [k, v] of Object.entries(node)) {
    if (keyPattern.test(k) && k !== 'a:Name') return v;
  }
  for (const v of Object.values(node)) {
    const found = Array.isArray(v) ? v : [v];
    for (const item of found) {
      if (item && typeof item === 'object') {
        const r = findCollection(item, keyPattern);
        if (r !== undefined) return r;
      }
    }
  }
  return undefined;
}

/** 在节点子树中找 key 匹配处下第一个带 @_Ref 的对象，返回 Ref 值 */
function findFirstRef(node: any, keyPattern: RegExp): string | undefined {
  let result: string | undefined;
  walkDeep(node, (k, v) => {
    if (result) return;
    if (keyPattern.test(k)) {
      for (const item of asArray(v)) {
        if (item && typeof item === 'object') {
          if (item['@_Ref']) {
            result = String(item['@_Ref']);
            return;
          }
          const inner = findFirstRef(item, /(^|:)\w+$/);
          if (inner) { result = inner; return; }
        }
      }
    }
  });
  return result;
}

function asArray(v: any): any[] {
  if (v == null) return [];
  return Array.isArray(v) ? v : [v];
}

function str(v: any): string | undefined {
  return v == null ? undefined : String(v);
}

function pick(...vals: any[]): string | undefined {
  for (const v of vals) {
    if (v != null && v !== '' && String(v).trim() !== '') return decodeEntities(String(v));
  }
  return undefined;
}

/**
 * PDM 的 a:Name 常写成「物理名(中文名)」，例如 T_BD_STAFF(员工表)、
 * V_ITEMCLASS_SUPPLYTYPE_L(多语言视图)。直接当显示名会与物理名重复展示两次
 * （"T_BD_STAFF_L — T_BD_STAFF_L(员工多语言表)"），故取括号内的中文名。
 * 返回 undefined 表示没有额外信息（与物理名完全相同）。
 */
function splitDisplay(display: string | undefined, phys: string): string | undefined {
  const d = (display || '').trim();
  if (!d) return undefined;
  const p = (phys || '').trim();
  if (p && d.toLowerCase() === p.toLowerCase()) return undefined;
  const m = d.match(/^([^(（]*)[（(]([^()（）]+)[)）]\s*$/);
  if (m && m[2].trim()) {
    const prefix = m[1].trim();
    // 前缀为空，或前缀正是物理名 → 取括号内作为显示名
    if (!prefix || (p && prefix.toLowerCase() === p.toLowerCase())) return m[2].trim();
  }
  return d;
}

/** 解码常用 XML 实体（processEntities:false 时需手动处理） */
function decodeEntities(s: string): string {
  if (!s.includes('&')) return s;
  return s
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(parseInt(d, 10)))
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
}

function isTrue(v: any): boolean {
  return v === true || v === 'true' || v === 1 || v === '1';
}

function inferType(c: any): string {
  const len = c['a:Length'];
  const prec = c['a:Precision'];
  const base = String(c['a:DataType'] || c['a:SSType'] || 'varchar');
  if (/char|binary/i.test(base) && len) return `${base}(${len})`;
  if (/decimal|numeric/i.test(base)) return `${base}(${prec || 10},${c['a:Scale'] || 0})`;
  return base;
}
