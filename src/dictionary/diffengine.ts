import { DictionaryModel, TableDef, ColumnDef, IndexDef, FkDef, findTable, findColumn, normalizeType, pkColumns } from './model';

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

/**
 * 比对两个字典（如：字典 vs 从真实库反向导入的快照）。
 * base = 现状（库），target = 期望（字典）。
 */
export function diffDictionaries(base: DictionaryModel, target: DictionaryModel): DiffItem[] {
  const items: DiffItem[] = [];
  const baseNames = new Set(base.tables.map((t) => t.name.toLowerCase()));

  for (const tt of target.tables) {
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
        items.push({ level: 'column', table: tt.name, object: tc.name, kind: 'added', changes: [{ prop: 'column', from: '-', to: tc.type }], dangerous: false });
        continue;
      }
      const changes = columnChanges(bc, tc);
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
    for (const ti of tt.indexes) {
      const bi = bt.indexes.find((i) => i.name.toLowerCase() === ti.name.toLowerCase());
      if (!bi) {
        items.push({ level: 'index', table: tt.name, object: ti.name, kind: 'added', changes: [{ prop: 'index', from: '-', to: ti.columns.join(',') }], dangerous: false });
      } else if (bi.columns.join(',').toLowerCase() !== ti.columns.join(',').toLowerCase() || bi.unique !== ti.unique) {
        items.push({ level: 'index', table: tt.name, object: ti.name, kind: 'modified', changes: [{ prop: '列', from: bi.columns.join(','), to: ti.columns.join(',') }], dangerous: false });
      }
    }
    // 外键级
    for (const tf of tt.foreignKeys) {
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

function columnChanges(base: ColumnDef, target: ColumnDef): DiffChange[] {
  const changes: DiffChange[] = [];
  if (normalizeType(base.type) !== normalizeType(target.type)) {
    changes.push({ prop: '类型', from: base.type, to: target.type });
  }
  if (!!base.pk !== !!target.pk) changes.push({ prop: '主键', from: base.pk ? '是' : '否', to: target.pk ? '是' : '否' });
  if ((base.nullable !== false) !== (target.nullable !== false)) {
    changes.push({ prop: '可空', from: base.nullable === false ? 'NOT NULL' : 'NULL', to: target.nullable === false ? 'NOT NULL' : 'NULL' });
  }
  if ((base.comment || '') !== (target.comment || '')) {
    changes.push({ prop: '注释', from: base.comment || '-', to: target.comment || '-' });
  }
  if ((base.defaultValue || '') !== (target.defaultValue || '')) {
    changes.push({ prop: '默认值', from: base.defaultValue || '-', to: target.defaultValue || '-' });
  }
  return changes;
}

/** 以 target(字典) 为准，生成把 base(库) 修成 target 的 SQL */
export function generateFixSql(base: DictionaryModel, target: DictionaryModel, includeDangerous = false): string[] {
  const dialect = target.dialect === 'postgres' ? 'pg' : target.dialect === 'mssql' ? 'mssql' : target.dialect === 'oracle' ? 'oracle' : 'mysql';
  const sqls: string[] = [];
  const q = (n: string) => (dialect === 'mysql' ? `\`${n}\`` : dialect === 'mssql' ? `[${n}]` : `"${n}"`);

  for (const tt of target.tables) {
    const bt = findTable(base, tt.name);
    if (!bt) {
      sqls.push(createTableSql(tt, dialect, q));
      continue;
    }
    for (const tc of tt.columns) {
      const bc = findColumn(bt, tc.name);
      if (!bc) {
        if (dialect === 'mssql') sqls.push(`ALTER TABLE ${q(tt.name)} ADD ${columnDefSql(tc, dialect, q)};`);
        else if (dialect === 'oracle') sqls.push(`ALTER TABLE ${q(tt.name)} ADD (${columnDefSql(tc, dialect, q)});`);
        else sqls.push(`ALTER TABLE ${q(tt.name)} ADD COLUMN ${columnDefSql(tc, dialect, q)};`);
        if (tc.comment && dialect !== 'mssql') sqls.push(commentColumnSql(tt.name, tc, dialect, q));
        continue;
      }
      const changed = columnChanges(bc, tc);
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
          sqls.push(`ALTER TABLE ${q(tt.name)} ALTER COLUMN ${columnDefSql(tc, dialect, q)};`);
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

function columnDefSql(c: ColumnDef, dialect: string, q: (n: string) => string): string {
  const parts = [q(c.name), c.type || 'varchar'];
  const dft = c.defaultValue !== undefined && c.defaultValue !== '' && !c.autoIncrement
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
export function mergeBaseIntoTarget(base: DictionaryModel, target: DictionaryModel): DictionaryModel {
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
        const changed = columnChanges(tc, bc);
        if (changed.length) {
          Object.assign(tc, JSON.parse(JSON.stringify(bc)));
          tc.changeTag = 'modified';
        }
      }
    }
    const baseNames = new Set(bt.columns.map((c) => c.name.toLowerCase()));
    for (const tc of tt.columns) {
      if (!baseNames.has(tc.name.toLowerCase()) && tc.changeTag !== 'deleted') {
        tc.changeTag = 'deleted';
      }
    }
  }
  const baseTableNames = new Set(base.tables.map((t) => t.name.toLowerCase()));
  for (const tt of merged.tables) {
    if (!baseTableNames.has(tt.name.toLowerCase()) && tt.changeTag !== 'added') {
      tt.changeTag = 'deleted';
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
