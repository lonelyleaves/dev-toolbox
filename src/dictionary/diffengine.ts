import { DictionaryModel, TableDef, ColumnDef, pkColumns } from './model';
import { typesEquivalent } from './type-canonical';

export interface DiffChange {
  prop: string;
  from: string;
  to: string;
}

export interface DiffItem {
  level: 'table' | 'column' | 'index' | 'fk';
  table: string;
  object: string;
  kind: 'added' | 'removed' | 'modified';
  changes: DiffChange[];
  dangerous: boolean;
}

/** 比对选项。默认只比对基线（JSON/库）返回的表，字典其余表不参与。 */
export interface DiffOptions {
  /** 全量比对：把字典里基线之外的表也标为 added（默认 false） */
  fullCompare?: boolean;
  /** 忽略注释差异 */
  ignoreComments?: boolean;
  /** 忽略默认值差异 */
  ignoreDefaults?: boolean;
  /** 忽略可空差异（金蝶等表单元数据的 MustInput 不等于数据库可空性） */
  ignoreNullable?: boolean;
  /** 忽略整型宽度差异（int ↔ bigint，金蝶元数据常用 bigint，PDM 常写 int） */
  ignoreIntegerWidth?: boolean;
  /**
   * 基线是元数据（如金蝶 WebAPI）：只校验“元数据里的字段是否被字典覆盖”，
   * 不反向要求字典字段都出现在元数据里（元数据不含系统字段/非表单字段，
   * 否则会把 FMasterId 这类真实列误报为缺失并生成 ADD COLUMN）。
   */
  metadataBaseline?: boolean;
  /**
   * 跳过索引/外键比对。
   * 金蝶 WebAPI 元数据不返回索引与外键，拿它当基线时若照常比对，
   * 会把字典里的索引/外键全判为缺失并生成一堆 CREATE INDEX / ADD CONSTRAINT。
   */
  skipRelations?: boolean;
  /** 只跳过外键：金蝶 HTML 数据字典有主外键表，但没有引用表信息 */
  skipForeignKeys?: boolean;
}

/**
 * 比对两个字典（如：字典 vs 从真实库反向导入的快照）。
 * base = 现状（库），target = 期望（字典）。
 */
export function diffDictionaries(base: DictionaryModel, target: DictionaryModel, opts: DiffOptions = {}): DiffItem[] {
  const items: DiffItem[] = [];
  // 大字典（3000+ 表）下不能用 Array.find 逐表查：O(n²) 会让 webview 直接卡死
  const baseIndex = new Map<string, TableDef>();
  for (const t of base.tables) {
    const k = t.name.toLowerCase();
    if (!baseIndex.has(k)) baseIndex.set(k, t);
  }
  const targetNames = new Set(target.tables.map((t) => t.name.toLowerCase()));
  const full = !!opts.fullCompare;

  for (const tt of target.tables) {
    const bt = baseIndex.get(tt.name.toLowerCase());
    // 默认只比对基线返回的表：字典里基线之外的表不参与（不标新增）
    if (!full && !bt) continue;
    if (!bt) {
      items.push({ level: 'table', table: tt.name, object: tt.name, kind: 'added', changes: [{ prop: 'table', from: '-', to: '新增' }], dangerous: false });
      continue;
    }
    // 列级
    const baseCols = new Map<string, ColumnDef>();
    for (const c of bt.columns) {
      const k = c.name.toLowerCase();
      if (!baseCols.has(k)) baseCols.set(k, c);
    }
    const ttNames = new Set(tt.columns.map((c) => c.name.toLowerCase()));
    for (const tc of tt.columns) {
      const bc = baseCols.get(tc.name.toLowerCase());
      if (!bc) {
        // 元数据基线不含系统字段：字典多出的列不反向报缺
        if (opts.metadataBaseline) continue;
        items.push({ level: 'column', table: tt.name, object: tc.name, kind: 'added', changes: [{ prop: 'column', from: '-', to: tc.type }], dangerous: false });
        continue;
      }
      const changes = columnChanges(bc, tc, opts, base.dialect, target.dialect);
      if (changes.length) {
        items.push({ level: 'column', table: tt.name, object: tc.name, kind: 'modified', changes, dangerous: changes.some((c) => c.prop === '类型') });
      }
    }
    for (const bc of bt.columns) {
      if (!ttNames.has(bc.name.toLowerCase())) {
        items.push({ level: 'column', table: tt.name, object: bc.name, kind: 'removed', changes: [{ prop: 'column', from: bc.type, to: '-' }], dangerous: true });
      }
    }
    if (!opts.skipRelations) {
      // 索引级
      const baseIdx = new Map(bt.indexes.map((i) => [i.name.toLowerCase(), i]));
      for (const ti of tt.indexes) {
        const bi = baseIdx.get(ti.name.toLowerCase());
        if (!bi) {
          items.push({ level: 'index', table: tt.name, object: ti.name, kind: 'added', changes: [{ prop: 'index', from: '-', to: ti.columns.join(',') }], dangerous: false });
        } else {
          const colDiff = bi.columns.join(',').toLowerCase() !== ti.columns.join(',').toLowerCase();
          const uniqDiff = bi.uniqueKnown !== false && ti.uniqueKnown !== false && bi.unique !== ti.unique;
          if (colDiff || uniqDiff) {
            const changes: DiffChange[] = [];
            if (colDiff) changes.push({ prop: '列', from: bi.columns.join(','), to: ti.columns.join(',') });
            if (uniqDiff) changes.push({ prop: '唯一', from: bi.unique ? '是' : '否', to: ti.unique ? '是' : '否' });
            items.push({ level: 'index', table: tt.name, object: ti.name, kind: 'modified', changes, dangerous: false });
          }
        }
      }
      // 外键级
      const baseFks = new Map(bt.foreignKeys.map((f) => [f.name.toLowerCase(), f]));
      if (!opts.skipForeignKeys) for (const tf of tt.foreignKeys) {
        if (!baseFks.has(tf.name.toLowerCase())) {
          items.push({ level: 'fk', table: tt.name, object: tf.name, kind: 'added', changes: [{ prop: 'fk', from: '-', to: `${tf.columns.join(',')} → ${tf.refTable}(${tf.refColumns.join(',')})` }], dangerous: false });
        }
      }
    }
  }
  for (const bt of base.tables) {
    if (!targetNames.has(bt.name.toLowerCase())) {
      items.push({ level: 'table', table: bt.name, object: bt.name, kind: 'removed', changes: [{ prop: 'table', from: bt.name, to: '-' }], dangerous: true });
    }
  }
  return items;
}

/** 注释归一化：去掉解析器拼的合成后缀（“；界面已隐藏”），避免假差异 */
function normComment(s?: string): string {
  return (s || '').replace(/[；;]?\s*界面已隐藏/g, '').replace(/[（(]\s*界面已隐藏\s*[)）]/g, '').trim();
}

/** 默认值归一化：去引号、布尔/位统一为 1/0，避免 '0' vs 0、True vs 1 这类格式假差异 */
function normDefault(s?: string): string {
  let v = (s ?? '').trim();
  if (!v) return '';
  if (/^'.*'$/.test(v)) v = v.slice(1, -1).trim();
  if (/^(true|1|y|yes|是)$/i.test(v)) return '1';
  if (/^(false|0|n|no|否)$/i.test(v)) return '0';
  return v;
}

function columnChanges(base: ColumnDef, target: ColumnDef, opts: DiffOptions = {}, baseDialect?: DictionaryModel['dialect'], targetDialect?: DictionaryModel['dialect']): DiffChange[] {
  const changes: DiffChange[] = [];
  // 推测字段（如 HTML 只给了主键名、没给字段定义）不参与属性比对，避免伪造差异
  if (base.guessed || target.guessed) return changes;
  const sameType = typesEquivalent(base.type, target.type, {
    ignoreIntegerWidth: opts.ignoreIntegerWidth,
    unknownLengthWildcard: true,
    baseDialect,
    targetDialect,
  });
  if (!sameType) {
    changes.push({ prop: '类型', from: base.type, to: target.type });
  }
  if (!!base.pk !== !!target.pk) changes.push({ prop: '主键', from: base.pk ? '是' : '否', to: target.pk ? '是' : '否' });
  if (!opts.ignoreNullable && (base.nullable !== false) !== (target.nullable !== false)) {
    changes.push({ prop: '可空', from: base.nullable === false ? 'NOT NULL' : 'NULL', to: target.nullable === false ? 'NOT NULL' : 'NULL' });
  }
  // 注释比对时把“显示名(code)”作为注释的兜底：PDM 常把中文名放在 code，comment 为空，
  // 直接按 comment 比会对每个字段都报“注释 → 空”的假差异
  const baseComment = normComment(base.comment || base.code);
  const targetComment = normComment(target.comment || target.code);
  if (!opts.ignoreComments && baseComment !== targetComment) {
    changes.push({ prop: '注释', from: base.comment || base.code || '-', to: target.comment || target.code || '-' });
  }
  if (!opts.ignoreDefaults && normDefault(base.defaultValue) !== normDefault(target.defaultValue)) {
    changes.push({ prop: '默认值', from: base.defaultValue || '-', to: target.defaultValue || '-' });
  }
  return changes;
}

/** 以 target(字典) 为准，生成把 base(库) 修成 target 的 SQL */
export function generateFixSql(base: DictionaryModel, target: DictionaryModel, includeDangerous = false, opts: DiffOptions = {}): string[] {
  // SQL 是在「现状库」上执行的：优先用基线方言（如 SQL Server 基线），
  // 之前用字典方言（PDM 导入常为 mysql），会给 SQL Server 生成反引号 + MODIFY COLUMN。
  const raw = base.dialect && base.dialect !== 'generic' ? base.dialect : target.dialect;
  const dialect = raw === 'postgres' ? 'pg' : raw === 'mssql' ? 'mssql' : raw === 'oracle' ? 'oracle' : 'mysql';
  const sqls: string[] = [];
  const q = (n: string) => (dialect === 'mysql' ? `\`${n.replace(/`/g, '``')}\`` : dialect === 'mssql' ? `[${n.replace(/]/g, ']]')}]` : `"${n.replace(/"/g, '""')}"`);
  const full = !!opts.fullCompare;
  const baseNames = new Set(base.tables.map((t) => t.name.toLowerCase()));
  const baseIndex = new Map<string, TableDef>();
  for (const t of base.tables) {
    const k = t.name.toLowerCase();
    if (!baseIndex.has(k)) baseIndex.set(k, t);
  }

  for (const tt of target.tables) {
    // 只为基线返回的表生成 SQL；字典额外表不生成 CREATE
    if (!full && !baseNames.has(tt.name.toLowerCase())) continue;
    const bt = baseIndex.get(tt.name.toLowerCase());
    if (!bt) {
      sqls.push(createTableSql(tt, dialect, q));
      continue;
    }
    const baseCols = new Map<string, ColumnDef>();
    for (const c of bt.columns) {
      const k = c.name.toLowerCase();
      if (!baseCols.has(k)) baseCols.set(k, c);
    }
    for (const tc of tt.columns) {
      const bc = baseCols.get(tc.name.toLowerCase());
      if (!bc) {
        if (opts.metadataBaseline) continue;
        if (dialect === 'mssql') sqls.push(`ALTER TABLE ${q(tt.name)} ADD ${columnDefSql(tc, dialect, q)};`);
        else if (dialect === 'oracle') sqls.push(`ALTER TABLE ${q(tt.name)} ADD (${columnDefSql(tc, dialect, q)});`);
        else sqls.push(`ALTER TABLE ${q(tt.name)} ADD COLUMN ${columnDefSql(tc, dialect, q)};`);
        if (tc.comment && dialect !== 'mssql') sqls.push(commentColumnSql(tt.name, tc, dialect, q));
        continue;
      }
      const changed = columnChanges(bc, tc, opts, base.dialect, target.dialect);
      if (!changed.length) continue;
      if (dialect === 'mysql') {
        if (changed.some((c) => c.prop !== '注释')) {
          sqls.push(`ALTER TABLE ${q(tt.name)} MODIFY COLUMN ${columnDefSql(tc, dialect, q)};`);
        }
        if (changed.some((c) => c.prop === '注释')) {
          sqls.push(commentColumnSql(tt.name, tc, dialect, q));
        }
      } else if (dialect === 'mssql') {
        if (changed.some((c) => c.prop !== '注释')) {
          // SQL Server 的 ALTER COLUMN 不接受 DEFAULT（需单独加约束）；修改列时去掉
          sqls.push(`ALTER TABLE ${q(tt.name)} ALTER COLUMN ${columnDefSql(tc, dialect, q, { noDefault: true })};`);
        }
      } else if (dialect === 'oracle') {
        if (changed.some((c) => c.prop !== '注释')) {
          sqls.push(`ALTER TABLE ${q(tt.name)} MODIFY (${columnDefSql(tc, dialect, q)});`);
        }
        if (changed.some((c) => c.prop === '注释')) {
          sqls.push(commentColumnSql(tt.name, tc, dialect, q));
        }
      } else {
        if (changed.some((c) => c.prop === '类型')) {
          sqls.push(`ALTER TABLE ${q(tt.name)} ALTER COLUMN ${q(tc.name)} TYPE ${tc.type};`);
        }
        if (changed.some((c) => c.prop === '可空')) {
          sqls.push(tc.nullable === false
            ? `ALTER TABLE ${q(tt.name)} ALTER COLUMN ${q(tc.name)} SET NOT NULL;`
            : `ALTER TABLE ${q(tt.name)} ALTER COLUMN ${q(tc.name)} DROP NOT NULL;`);
        }
        if (changed.some((c) => c.prop === '默认值')) {
          sqls.push(tc.defaultValue
            ? `ALTER TABLE ${q(tt.name)} ALTER COLUMN ${q(tc.name)} SET DEFAULT ${defaultExpr(tc.defaultValue)};`
            : `ALTER TABLE ${q(tt.name)} ALTER COLUMN ${q(tc.name)} DROP DEFAULT;`);
        }
        if (changed.some((c) => c.prop === '注释')) {
          sqls.push(commentColumnSql(tt.name, tc, dialect, q));
        }
      }
    }
    if (includeDangerous) {
      const ttNames = new Set(tt.columns.map((c) => c.name.toLowerCase()));
      for (const bc of bt.columns) {
        if (!ttNames.has(bc.name.toLowerCase())) {
          sqls.push(dialect === 'oracle'
            ? `ALTER TABLE ${q(tt.name)} DROP (${q(bc.name)});`
            : `ALTER TABLE ${q(tt.name)} DROP COLUMN ${q(bc.name)};`);
        }
      }
    }
    const baseIdx = new Map(bt.indexes.map((i) => [i.name.toLowerCase(), i]));
    for (const ti of tt.indexes) {
      if (opts.skipRelations) break;
      const bi = baseIdx.get(ti.name.toLowerCase());
      if (!bi) {
        sqls.push(`CREATE ${ti.unique ? 'UNIQUE ' : ''}INDEX ${q(ti.name)} ON ${q(tt.name)} (${ti.columns.map(q).join(', ')});`);
      } else if (bi.columns.join(',').toLowerCase() !== ti.columns.join(',').toLowerCase()
        || (bi.uniqueKnown !== false && ti.uniqueKnown !== false && bi.unique !== ti.unique)) {
        if (dialect === 'mysql') sqls.push(`ALTER TABLE ${q(tt.name)} DROP INDEX ${q(bi.name)};`);
        else if (dialect === 'mssql') sqls.push(`DROP INDEX ${q(bi.name)} ON ${q(tt.name)};`);
        else if (dialect === 'oracle') sqls.push(`DROP INDEX ${q(bi.name)};`);
        else sqls.push(`DROP INDEX IF EXISTS ${q(bi.name)};`);
        sqls.push(`CREATE ${ti.unique ? 'UNIQUE ' : ''}INDEX ${q(ti.name)} ON ${q(tt.name)} (${ti.columns.map(q).join(', ')});`);
      }
    }
    const baseFks = new Map(bt.foreignKeys.map((f) => [f.name.toLowerCase(), f]));
    for (const tf of tt.foreignKeys) {
      if (opts.skipRelations || opts.skipForeignKeys) break;
      const bf = baseFks.get(tf.name.toLowerCase());
      if (!bf) {
        sqls.push(`ALTER TABLE ${q(tt.name)} ADD CONSTRAINT ${q(tf.name)} FOREIGN KEY (${tf.columns.map(q).join(', ')}) REFERENCES ${q(tf.refTable)} (${tf.refColumns.map(q).join(', ')});`);
      }
    }
  }
  if (includeDangerous) {
    const targetNames = new Set(target.tables.map((t) => t.name.toLowerCase()));
    for (const bt of base.tables) {
      if (!targetNames.has(bt.name.toLowerCase())) sqls.push(`DROP TABLE ${q(bt.name)};`);
    }
  }
  return sqls;
}

function defaultExpr(raw: string): string {
  let s = String(raw ?? '').trim();
  for (let i = 0; i < 3; i++) {
    const m = s.match(/^\((.*)\)$/);
    if (!m) break;
    s = m[1].trim();
  }
  if (!s) return "''";
  if (/^(current_timestamp|now\(\)|getdate\(\)|sysdatetime\(\)|newid\(\)|NULL)$/i.test(s)) return s;
  if (/^-?\d+(?:\.\d+)?$/.test(s)) return s;
  // N'x' / 'x'：保留 N 前缀，内部单引号转义，避免 O'Reilly 这类默认值把 SQL 拼坏
  const nq = s.match(/^N'([\s\S]*)'$/i);
  if (nq) return `N'${nq[1].replace(/'/g, "''")}'`;
  const q = s.match(/^'([\s\S]*)'$/);
  if (q) return `'${q[1].replace(/'/g, "''")}'`;
  return `'${s.replace(/'/g, "''")}'`;
}

function columnDefSql(c: ColumnDef, dialect: string, q: (n: string) => string, opts: { noDefault?: boolean } = {}): string {
  const parts = [q(c.name), c.type || 'varchar'];
  const dft = !opts.noDefault && c.defaultValue !== undefined && c.defaultValue !== '' && !c.autoIncrement
    ? `DEFAULT ${defaultExpr(c.defaultValue)}`
    : '';
  if (dialect === 'mysql') {
    if (c.autoIncrement) parts.push('AUTO_INCREMENT');
    parts.push(c.nullable === false ? 'NOT NULL' : 'NULL');
    if (dft) parts.push(dft);
    if (c.comment) parts.push(`COMMENT '${c.comment.replace(/'/g, "''")}'`);
  } else if (dialect === 'mssql') {
    if (c.autoIncrement) parts.push('IDENTITY(1,1)');
    parts.push(c.nullable === false ? 'NOT NULL' : 'NULL');
    if (dft && !c.autoIncrement) parts.push(dft);
  } else if (dialect === 'oracle') {
    if (dft) parts.push(dft);
    if (c.nullable === false) parts.push('NOT NULL');
  } else {
    parts.push(c.nullable === false ? 'NOT NULL' : '');
    if (dft) parts.push(dft);
  }
  return parts.filter(Boolean).join(' ');
}

export function createTableSql(t: TableDef, dialect: string, q: (n: string) => string): string {
  const cols = t.columns.map((c) => '  ' + columnDefSql(c, dialect, q));
  const pks = pkColumns(t);
  if (pks.length) cols.push(`  PRIMARY KEY (${pks.map((c) => q(c.name)).join(', ')})`);
  if (dialect === 'mysql') {
    for (const i of t.indexes) cols.push(`  ${i.unique ? 'UNIQUE ' : ''}KEY ${q(i.name)} (${i.columns.map(q).join(', ')})`);
  }
  let sql = `CREATE TABLE ${q(t.name)} (\n${cols.join(',\n')}\n)`;
  if (dialect === 'mysql' && t.comment) sql += ` COMMENT='${t.comment.replace(/'/g, "''")}'`;
  sql += ';';
  if ((dialect === 'pg' || dialect === 'oracle') && t.comment) sql += `\nCOMMENT ON TABLE ${q(t.name)} IS '${t.comment.replace(/'/g, "''")}';`;
  if (dialect === 'pg' || dialect === 'oracle') {
    for (const c of t.columns) if (c.comment) sql += `\n${commentColumnSql(t.name, c, dialect, q)}`;
  }
  if (dialect === 'mssql' || dialect === 'oracle') {
    for (const i of t.indexes) sql += `\nCREATE ${i.unique ? 'UNIQUE ' : ''}INDEX ${q(i.name)} ON ${q(t.name)} (${i.columns.map(q).join(', ')});`;
  }
  return sql;
}

function commentColumnSql(table: string, c: ColumnDef, dialect: string, q: (n: string) => string): string {
  const text = (c.comment || '').replace(/'/g, "''");
  if (dialect === 'mysql') return `ALTER TABLE ${q(table)} MODIFY COLUMN ${q(c.name)} ${c.type} COMMENT '${text}';`;
  if (dialect === 'mssql') return `-- SQL Server 注释需手动执行: EXEC sp_addextendedproperty 'MS_Description', N'${text}', 'SCHEMA', N'dbo', 'TABLE', N'${table}', 'COLUMN', N'${c.name}';`;
  return `COMMENT ON COLUMN ${q(table)}.${q(c.name)} IS '${text}';`;
}

/** 把 base 的指定对象标记同步到 target（"以库为准回写字典"时由 UI 调用后保存） */
export function mergeBaseIntoTarget(base: DictionaryModel, target: DictionaryModel, opts: DiffOptions = {}): DictionaryModel {
  const full = !!opts.fullCompare;
  const merged: DictionaryModel = JSON.parse(JSON.stringify(target));
  // 大字典下逐表 find 是 O(n²)，这里先建表索引
  const tableIndex = new Map<string, TableDef>();
  for (const t of merged.tables) {
    const k = t.name.toLowerCase();
    if (!tableIndex.has(k)) tableIndex.set(k, t);
  }
  for (const bt of base.tables) {
    const key = bt.name.toLowerCase();
    let tt = tableIndex.get(key);
    if (!tt) {
      const copy: TableDef = JSON.parse(JSON.stringify(bt));
      copy.changeTag = 'added';
      merged.tables.push(copy);
      tableIndex.set(key, copy);
      continue;
    }
    tt.comment = bt.comment ?? tt.comment;
    // 索引/外键也按基线回写；WebAPI 元数据没有这些信息时保留字典原值
    if (bt.indexes.length) tt.indexes = JSON.parse(JSON.stringify(bt.indexes));
    if (bt.foreignKeys.length) tt.foreignKeys = JSON.parse(JSON.stringify(bt.foreignKeys));
    const colIndex = new Map<string, ColumnDef>();
    for (const c of tt.columns) {
      const k = c.name.toLowerCase();
      if (!colIndex.has(k)) colIndex.set(k, c);
    }
    for (const bc of bt.columns) {
      const ck = bc.name.toLowerCase();
      const tc = colIndex.get(ck);
      if (!tc) {
        const copy: ColumnDef = JSON.parse(JSON.stringify(bc));
        copy.changeTag = 'added';
        tt.columns.push(copy);
        colIndex.set(ck, copy);
      } else {
        const changed = columnChanges(tc, bc, opts, target.dialect, base.dialect);
        if (changed.length) {
          Object.assign(tc, JSON.parse(JSON.stringify(bc)));
          tc.changeTag = 'modified';
        }
      }
    }
    // 元数据基线不含系统字段：不能把字典里元数据未列出的列标为 deleted
    if (opts.metadataBaseline) continue;
    const baseNames = new Set(bt.columns.map((c) => c.name.toLowerCase()));
    for (const tc of tt.columns) {
      if (!baseNames.has(tc.name.toLowerCase()) && tc.changeTag !== 'deleted') {
        tc.changeTag = 'deleted';
      }
    }
  }
  // 仅全量比对时，才把基线之外的字典表标为 deleted；
  // 局部基线（如单个表单 3 表）下不能把字典其余 1000+ 表误标删除
  if (full) {
    const baseTableNames = new Set(base.tables.map((t) => t.name.toLowerCase()));
    for (const tt of merged.tables) {
      if (!baseTableNames.has(tt.name.toLowerCase()) && tt.changeTag !== 'added') {
        tt.changeTag = 'deleted';
      }
    }
  }
  merged.importErrors = [...merged.importErrors, { source: 'merge', message: `已按库结构回写，标记变更 ${countTags(merged)} 处` }];
  return merged;
}

function countTags(d: DictionaryModel): number {
  let n = 0;
  for (const t of d.tables) {
    if (t.changeTag) n++;
    for (const c of t.columns) if (c.changeTag) n++;
  }
  return n;
}

/** 差异报告 Markdown */
export function diffReportMarkdown(base: DictionaryModel, target: DictionaryModel, items: DiffItem[]): string {
  const lines = [
    `# 数据字典差异报告`,
    ``,
    `- 现状(库): ${base.name}`,
    `- 期望(字典): ${target.name}`,
    `- 生成时间: ${new Date().toLocaleString('zh-CN')}`,
    `- 差异总数: ${items.length}（危险项 ${items.filter((i) => i.dangerous).length}）`,
    ``,
    `| 级别 | 表 | 对象 | 类型 | 明细 | 危险 |`,
    `|---|---|---|---|---|---|`,
  ];
  for (const it of items) {
    const detail = it.changes.map((c) => `${c.prop}: ${c.from} → ${c.to}`).join('；');
    lines.push(`| ${it.level} | ${it.table} | ${it.object} | ${{ added: '新增', removed: '删除', modified: '变更' }[it.kind]} | ${detail} | ${it.dangerous ? '⚠' : ''} |`);
  }
  return lines.join('\n');
}
