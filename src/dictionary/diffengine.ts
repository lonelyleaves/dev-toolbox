import { DictionaryModel, TableDef, ColumnDef, IndexDef, FkDef, findTable, findColumn, pkColumns } from './model';
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
}

/**
 * 比对两个字典（如：字典 vs 从真实库反向导入的快照）。
 * base = 现状（库），target = 期望（字典）。
 */
export function diffDictionaries(base: DictionaryModel, target: DictionaryModel, opts: DiffOptions = {}): DiffItem[] {
  const items: DiffItem[] = [];
  const baseNames = new Set(base.tables.map((t) => t.name.toLowerCase()));
  const full = !!opts.fullCompare;

  for (const tt of target.tables) {
    // 默认只比对基线返回的表：字典里基线之外的表不参与（不标新增）
    if (!full && !baseNames.has(tt.name.toLowerCase())) continue;
    const bt = findTable(base, tt.name);
    if (!bt) {
      items.push({ level: 'table', table: tt.name, object: tt.name, kind: 'added', changes: [{ prop: 'table', from: '-', to: '新增' }], dangerous: false });
      continue;
    }
    // 列级
    const ttNames = new Set(tt.columns.map((c) => c.name.toLowerCase()));
    for (const tc of tt.columns) {
      const bc = findColumn(bt, tc.name);
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
    // 索引级
    if (!opts.skipRelations) for (const ti of tt.indexes) {
      const bi = bt.indexes.find((i) => i.name.toLowerCase() === ti.name.toLowerCase());
      if (!bi) {
        items.push({ level: 'index', table: tt.name, object: ti.name, kind: 'added', changes: [{ prop: 'index', from: '-', to: ti.columns.join(',') }], dangerous: false });
      } else if (bi.columns.join(',').toLowerCase() !== ti.columns.join(',').toLowerCase() || bi.unique !== ti.unique) {
        items.push({ level: 'index', table: tt.name, object: ti.name, kind: 'modified', changes: [{ prop: '列', from: bi.columns.join(','), to: ti.columns.join(',') }], dangerous: false });
      }
    }
    // 外键级
    if (!opts.skipRelations) for (const tf of tt.foreignKeys) {
      const bf = bt.foreignKeys.find((f) => f.name.toLowerCase() === tf.name.toLowerCase());
      if (!bf) {
        items.push({ level: 'fk', table: tt.name, object: tf.name, kind: 'added', changes: [{ prop: 'fk', from: '-', to: `${tf.columns.join(',')} → ${tf.refTable}(${tf.refColumns.join(',')})` }], dangerous: false });
      }
    }
  }
  for (const bt of base.tables) {
    if (!new Set(target.tables.map((t) => t.name.toLowerCase())).has(bt.name.toLowerCase())) {
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
  if (!opts.ignoreComments && normComment(base.comment) !== normComment(target.comment)) {
    changes.push({ prop: '注释', from: base.comment || '-', to: target.comment || '-' });
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
  const q = (n: string) => (dialect === 'mysql' ? `\`${n}\`` : dialect === 'mssql' ? `[${n}]` : `"${n}"`);
  const full = !!opts.fullCompare;
  const baseNames = new Set(base.tables.map((t) => t.name.toLowerCase()));

  for (const tt of target.tables) {
    // 只为基线返回的表生成 SQL；字典额外表不生成 CREATE
    if (!full && !baseNames.has(tt.name.toLowerCase())) continue;
    const bt = findTable(base, tt.name);
    if (!bt) {
      sqls.push(createTableSql(tt, dialect, q));
      continue;
    }
    for (const tc of tt.columns) {
      const bc = findColumn(bt, tc.name);
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
            ? `ALTER TABLE ${q(tt.name)} ALTER COLUMN ${q(tc.name)} SET DEFAULT ${tc.defaultValue};`
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
    for (const ti of tt.indexes) {
      if (opts.skipRelations) break;
      const bi = bt.indexes.find((i) => i.name.toLowerCase() === ti.name.toLowerCase());
      if (!bi) {
        sqls.push(`CREATE ${ti.unique ? 'UNIQUE ' : ''}INDEX ${q(ti.name)} ON ${q(tt.name)} (${ti.columns.map(q).join(', ')});`);
      } else if (bi.columns.join(',').toLowerCase() !== ti.columns.join(',').toLowerCase() || bi.unique !== ti.unique) {
        if (dialect === 'mysql') sqls.push(`ALTER TABLE ${q(tt.name)} DROP INDEX ${q(bi.name)};`);
        else if (dialect === 'mssql') sqls.push(`DROP INDEX ${q(bi.name)} ON ${q(tt.name)};`);
        else if (dialect === 'oracle') sqls.push(`DROP INDEX ${q(bi.name)};`);
        else sqls.push(`DROP INDEX IF EXISTS ${q(bi.name)};`);
        sqls.push(`CREATE ${ti.unique ? 'UNIQUE ' : ''}INDEX ${q(ti.name)} ON ${q(tt.name)} (${ti.columns.map(q).join(', ')});`);
      }
    }
    for (const tf of tt.foreignKeys) {
      if (opts.skipRelations) break;
      const bf = bt.foreignKeys.find((f) => f.name.toLowerCase() === tf.name.toLowerCase());
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

function columnDefSql(c: ColumnDef, dialect: string, q: (n: string) => string, opts: { noDefault?: boolean } = {}): string {
  const parts = [q(c.name), c.type || 'varchar'];
  const dft = !opts.noDefault && c.defaultValue !== undefined && c.defaultValue !== '' && !c.autoIncrement
    ? `DEFAULT ${/^(current_timestamp|now\(\)|getdate\(\)|\d+(\.\d+)?|'(.*)'|NULL|N'(.*)')$/i.test(c.defaultValue) ? c.defaultValue : `'${c.defaultValue}'`}`
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
  for (const bt of base.tables) {
    const tt = findTable(merged, bt.name);
    if (!tt) {
      const copy: TableDef = JSON.parse(JSON.stringify(bt));
      copy.changeTag = 'added';
      merged.tables.push(copy);
      continue;
    }
    tt.comment = bt.comment ?? tt.comment;
    for (const bc of bt.columns) {
      const tc = findColumn(tt, bc.name);
      if (!tc) {
        const copy: ColumnDef = JSON.parse(JSON.stringify(bc));
        copy.changeTag = 'added';
        tt.columns.push(copy);
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
