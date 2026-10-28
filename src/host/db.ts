import * as vscode from 'vscode';
import { DbConnInfo } from '../core/messaging';
import { DictionaryModel, emptyDictionary, TableDef } from '../dictionary/model';
import { projectSecretKey } from './project-store';

async function resolvePassword(info: DbConnInfo, secrets: vscode.SecretStorage): Promise<string> {
  if (info.password) return info.password;
  // 项目级凭据优先：同一个库在不同项目/不同配置里可以是不同密码
  if (info.projectId) {
    const raw = await secrets.get(projectSecretKey(info.projectId, 'db', info.configId));
    try { return raw ? String(JSON.parse(raw)?.password ?? '') : ''; } catch { return raw ?? ''; }
  }
  if (info.secretKey) return (await secrets.get(info.secretKey)) ?? '';
  return '';
}

function connKey(info: DbConnInfo): string {
  return `devtoolbox.db.${info.client}.${info.host}.${info.port}.${info.database}.${info.user}`;
}

export async function saveDbPassword(info: DbConnInfo, password: string, secrets: vscode.SecretStorage) {
  if (info.projectId) {
    const key = projectSecretKey(info.projectId, 'db', info.configId);
    await secrets.store(key, JSON.stringify({ password }));
    return;
  }
  await secrets.store(connKey(info), password);
}

export async function testConnection(info: DbConnInfo, secrets: vscode.SecretStorage): Promise<string> {
  const password = await resolvePassword({ ...info, secretKey: connKey(info) }, secrets);
  if (info.client === 'mysql') {
    const mysql = await import('mysql2/promise');
    const conn = await mysql.createConnection({
      host: info.host, port: info.port, user: info.user, password, database: info.database, connectTimeout: 8000,
    });
    const [rows]: any = await conn.query('SELECT VERSION() AS v');
    await conn.end();
    return rows[0]?.v ?? 'MySQL';
  }
  if (info.client === 'mssql') {
    const sql = await import('mssql');
    const pool = await sql.default.connect({
      server: info.host, port: info.port, user: info.user, password, database: info.database,
      options: { encrypt: false, trustServerCertificate: true }, connectionTimeout: 8000, requestTimeout: 8000,
    });
    const r = await pool.request().query('SELECT @@VERSION AS v');
    await pool.close();
    return String(r.recordset[0]?.v ?? 'SQL Server').split('\n')[0];
  }
  if (info.client === 'oracle') {
    const oracledb = await import('oracledb');
    const conn = await oracledb.default.getConnection({
      user: info.user, password, connectString: `${info.host}:${info.port}/${info.database}`,
    });
    const r = await conn.execute('SELECT banner FROM v$version WHERE ROWNUM = 1');
    await conn.close();
    return String(r.rows[0]?.[0] ?? 'Oracle');
  }
  const { Client } = await import('pg');
  const client = new Client({
    host: info.host, port: info.port, user: info.user, password, database: info.database, connectionTimeoutMillis: 8000,
  });
  await client.connect();
  const res = await client.query('SELECT version()');
  await client.end();
  return String(res.rows[0]?.version ?? 'PostgreSQL');
}

/** 反向导入：读取库表结构生成 DictionaryModel */
export async function introspect(info: DbConnInfo, secrets: vscode.SecretStorage): Promise<DictionaryModel> {
  const password = await resolvePassword({ ...info, secretKey: connKey(info) }, secrets);
  switch (info.client) {
    case 'mysql': return introspectMysql(info, password);
    case 'mssql': return introspectMssql(info, password);
    case 'oracle': return introspectOracle(info, password);
    default: return introspectPg(info, password);
  }
}

async function introspectMysql(info: DbConnInfo, password: string): Promise<DictionaryModel> {
  const mysql = await import('mysql2/promise');
  const conn = await mysql.createConnection({
    host: info.host, port: info.port, user: info.user, password, database: info.database,
    connectTimeout: 15000, multipleStatements: false,
  });
  try {
    const dict = emptyDictionary(`${info.host}/${info.database}`, 'mysql');
    const [tables]: any = await conn.query(
      `SELECT TABLE_NAME n, TABLE_COMMENT c FROM information_schema.TABLES
       WHERE TABLE_SCHEMA = ? AND TABLE_TYPE = 'BASE TABLE' ORDER BY TABLE_NAME`,
      [info.database]
    );
    for (const t of tables) {
      const table: TableDef = { name: t.n, comment: t.c || undefined, columns: [], indexes: [], foreignKeys: [] };
      const [cols]: any = await conn.query(
        `SELECT COLUMN_NAME n, COLUMN_TYPE ty, IS_NULLABLE nu, COLUMN_KEY k, COLUMN_DEFAULT d, EXTRA e, COLUMN_COMMENT c
         FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? ORDER BY ORDINAL_POSITION`,
        [info.database, t.n]
      );
      for (const c of cols) {
        table.columns.push({
          name: c.n, type: c.ty, nullable: c.nu === 'YES', pk: c.k === 'PRI',
          defaultValue: c.d == null ? undefined : String(c.d),
          autoIncrement: /auto_increment/i.test(c.e || ''),
          comment: c.c || undefined,
        });
      }
      const [idx]: any = await conn.query(
        `SELECT INDEX_NAME n, NON_UNIQUE u, GROUP_CONCAT(COLUMN_NAME ORDER BY SEQ_IN_INDEX) cols
         FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ?
         GROUP BY INDEX_NAME, NON_UNIQUE ORDER BY INDEX_NAME`,
        [info.database, t.n]
      );
      for (const i of idx) {
        if (i.n === 'PRIMARY') continue;
        table.indexes.push({ name: i.n, unique: !i.u, columns: String(i.cols).split(',') });
      }
      const [fks]: any = await conn.query(
        `SELECT CONSTRAINT_NAME n, COLUMN_NAME col, REFERENCED_TABLE_NAME rt, REFERENCED_COLUMN_NAME rc
         FROM information_schema.KEY_COLUMN_USAGE
         WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? AND REFERENCED_TABLE_NAME IS NOT NULL
         ORDER BY CONSTRAINT_NAME, ORDINAL_POSITION`,
        [info.database, t.n]
      );
      const fkMap = new Map<string, { cols: string[]; rt: string; rc: string[] }>();
      for (const f of fks) {
        const e: { cols: string[]; rt: string; rc: string[] } = fkMap.get(f.n) || { cols: [], rt: f.rt, rc: [] };
        e.cols.push(f.col);
        e.rc.push(f.rc);
        fkMap.set(f.n, e);
      }
      for (const [n, e] of fkMap) {
        table.foreignKeys.push({ name: n, columns: e.cols, refTable: e.rt, refColumns: e.rc });
      }
      dict.tables.push(table);
    }
    dict.meta = { source: `mysql://${info.host}:${info.port}/${info.database}`, importedAt: new Date().toISOString() };
    return dict;
  } finally {
    await conn.end();
  }
}

async function introspectPg(info: DbConnInfo, password: string): Promise<DictionaryModel> {
  const { Client } = await import('pg');
  const client = new Client({
    host: info.host, port: info.port, user: info.user, password, database: info.database, connectionTimeoutMillis: 15000,
  });
  await client.connect();
  try {
    const schema = 'public';
    const dict = emptyDictionary(`${info.host}/${info.database}`, 'postgres');
    const tables = (
      await client.query(
        `SELECT c.relname n, obj_description(c.oid) c FROM pg_class c
         JOIN pg_namespace ns ON ns.oid = c.relnamespace
         WHERE ns.nspname = $1 AND c.relkind = 'r' ORDER BY c.relname`,
        [schema]
      )
    ).rows;
    for (const t of tables) {
      const table: TableDef = { name: t.n, comment: t.c || undefined, columns: [], indexes: [], foreignKeys: [] };
      const cols = (
        await client.query(
          `SELECT a.attname n, format_type(a.atttypid, a.atttypmod) ty, NOT a.attnotnull nu,
                  pg_get_expr(d.adbin, d.adrelnum) d,
                  col_description(a.attrelid, a.attnum) c,
                  a.attnum IN (SELECT unnest(indkey)::int FROM pg_index i
                    WHERE i.indrelid = a.attrelid AND i.indisprimary) pk
           FROM pg_attribute a
           LEFT JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
           WHERE a.attrelid = $1::regclass AND a.attnum > 0 AND NOT a.attisdropped ORDER BY a.attnum`,
          [`"${schema}"."${t.n}"`]
        )
      ).rows;
      for (const c of cols) {
        table.columns.push({
          name: c.n, type: c.ty, nullable: c.nu, pk: !!c.pk,
          defaultValue: c.d == null ? undefined : String(c.d),
          autoIncrement: /nextval\(/i.test(String(c.d || '')),
          comment: c.c || undefined,
        });
      }
      const idx = (
        await client.query(
          `SELECT i.relname n, ix.indisunique u,
                  array_to_string(array_agg(a.attname ORDER BY x.ord), ',') cols
           FROM pg_index ix
           JOIN pg_class i ON i.oid = ix.indexrelid
           JOIN pg_class t ON t.oid = ix.indrelid
           JOIN pg_namespace ns ON ns.oid = t.relnamespace
           JOIN LATERAL unnest(ix.indkey) WITH ORDINALITY AS x(attnum, ord) ON true
           JOIN pg_attribute a ON a.attrelid = t.oid AND a.attnum = x.attnum
           WHERE ns.nspname = $1 AND t.relname = $2 AND NOT ix.indisprimary
           GROUP BY i.relname, ix.indisunique ORDER BY i.relname`,
          [schema, t.n]
        )
      ).rows;
      for (const i of idx) {
        table.indexes.push({ name: i.n, unique: i.u, columns: String(i.cols).split(',') });
      }
      const fks = (
        await client.query(
          `SELECT con.conname n,
                  array_to_string(array_agg(local.attname ORDER BY x.ord), ',') cols,
                  foret.relname rt,
                  array_to_string(array_agg(fored.attname ORDER BY x.ord), ',') rc
           FROM pg_constraint con
           JOIN pg_class rel ON rel.oid = con.conrelid
           JOIN pg_class foret ON foret.oid = con.confrelid
           JOIN pg_namespace ns ON ns.oid = rel.relnamespace
           JOIN LATERAL unnest(con.conkey, con.confkey) WITH ORDINALITY AS x(lcol, fcol, ord) ON true
           JOIN pg_attribute local ON local.attrelid = rel.oid AND local.attnum = x.lcol
           JOIN pg_attribute fored ON fored.attrelid = foret.oid AND fored.attnum = x.fcol
           WHERE ns.nspname = $1 AND rel.relname = $2 AND con.contype = 'f'
           GROUP BY con.conname, foret.relname ORDER BY con.conname`,
          [schema, t.n]
        )
      ).rows;
      for (const f of fks) {
        table.foreignKeys.push({ name: f.n, columns: String(f.cols).split(','), refTable: f.rt, refColumns: String(f.rc).split(',') });
      }
      dict.tables.push(table);
    }
    dict.meta = { source: `postgres://${info.host}:${info.port}/${info.database}`, importedAt: new Date().toISOString() };
    return dict;
  } finally {
    await client.end();
  }
}

async function introspectMssql(info: DbConnInfo, password: string): Promise<DictionaryModel> {
  const sql = await import('mssql');
  const pool = await sql.default.connect({
    server: info.host, port: info.port, user: info.user, password, database: info.database,
    options: { encrypt: false, trustServerCertificate: true }, connectionTimeout: 15000, requestTimeout: 60000,
  });
  try {
    const dict = emptyDictionary(`${info.host}/${info.database}`, 'mssql');
    const tables = (await pool.request().query(`
      SELECT t.name n, CAST(ep.value AS NVARCHAR(1000)) c
      FROM sys.tables t
      LEFT JOIN sys.extended_properties ep ON ep.major_id = t.object_id AND ep.minor_id = 0 AND ep.name = 'MS_Description'
      ORDER BY t.name`)).recordset;
    for (const t of tables) {
      const tn = String(t.n ?? '');
      const table: TableDef = { name: tn, comment: t.c || undefined, columns: [], indexes: [], foreignKeys: [] };
      const cols = (await pool.request().input('tn', sql.default.NVarChar(200), tn).query(`
        SELECT c.name n,
          t.name + CASE
            WHEN t.name IN ('varchar','nvarchar','char','nchar','varbinary') THEN '(' + CASE WHEN c.max_length = -1 THEN 'max' ELSE CAST(CASE WHEN t.name LIKE 'n%' THEN c.max_length/2 ELSE c.max_length END AS varchar) + ')' END
            WHEN t.name IN ('decimal','numeric') THEN '(' + CAST(c.precision AS varchar) + ',' + CAST(c.scale AS varchar) + ')'
            ELSE '' END ty,
          CASE WHEN c.is_nullable = 1 THEN 'YES' ELSE 'NO' END nu,
          CASE WHEN EXISTS (
            SELECT 1 FROM sys.index_columns ic2
            JOIN sys.indexes i2 ON i2.object_id = ic2.object_id AND i2.index_id = ic2.index_id AND i2.is_primary_key = 1
            WHERE ic2.object_id = c.object_id AND ic2.column_id = c.column_id
          ) THEN 'PRI' ELSE '' END k,
          CAST(d.definition AS varchar) d,
          c.is_identity idn,
          CAST(ep.value AS NVARCHAR(1000)) cmt
        FROM sys.columns c
        JOIN sys.types t ON t.user_type_id = c.user_type_id
        LEFT JOIN sys.default_constraints d ON d.object_id = c.default_object_id
        LEFT JOIN sys.extended_properties ep ON ep.major_id = c.object_id AND ep.minor_id = c.column_id AND ep.name = 'MS_Description'
        WHERE c.object_id = OBJECT_ID(@tn)
        ORDER BY c.column_id`)).recordset;
      for (const c of cols) {
        table.columns.push({
          name: c.n, type: c.ty, nullable: c.nu === 'YES', pk: c.k === 'PRI',
          defaultValue: c.d ? String(c.d).replace(/[()]/g, '') : undefined,
          autoIncrement: !!c.idn, comment: c.cmt || undefined,
        });
      }
      const idx = (await pool.request().input('tn', sql.default.NVarChar(200), tn).query(`
        SELECT i.name n, CASE WHEN i.is_unique = 1 THEN 1 ELSE 0 END u,
          STUFF((SELECT ',' + c2.name FROM sys.index_columns ic2 JOIN sys.columns c2 ON c2.object_id = ic2.object_id AND c2.column_id = ic2.column_id
            WHERE ic2.object_id = i.object_id AND ic2.index_id = i.index_id ORDER BY ic2.key_ordinal FOR XML PATH('')), 1, 1, '') cols
        FROM sys.indexes i
        WHERE i.object_id = OBJECT_ID(@tn) AND i.is_primary_key = 0 AND i.name IS NOT NULL
        ORDER BY i.name`)).recordset;
      for (const i of idx) {
        table.indexes.push({ name: i.n, unique: !!i.u, columns: String(i.cols).split(',') });
      }
      const fks = (await pool.request().input('tn', sql.default.NVarChar(200), tn).query(`
        SELECT fk.name n, COL_NAME(fkc.parent_object_id, fkc.parent_column_id) col,
          OBJECT_NAME(fk.referenced_object_id) rt, COL_NAME(fkc.referenced_object_id, fkc.referenced_column_id) rc
        FROM sys.foreign_keys fk
        JOIN sys.foreign_key_columns fkc ON fkc.constraint_object_id = fk.object_id
        WHERE fk.parent_object_id = OBJECT_ID(@tn)
        ORDER BY fk.name, fkc.constraint_column_id`)).recordset;
      const fkMap = new Map<string, { cols: string[]; rt: string; rc: string[] }>();
      for (const f of fks) {
        const e: { cols: string[]; rt: string; rc: string[] } = fkMap.get(f.n) || { cols: [], rt: f.rt, rc: [] };
        e.cols.push(f.col);
        e.rc.push(f.rc);
        fkMap.set(f.n, e);
      }
      for (const [n, e] of fkMap) {
        table.foreignKeys.push({ name: n, columns: e.cols, refTable: e.rt, refColumns: e.rc });
      }
      dict.tables.push(table);
    }
    dict.meta = { source: `sqlserver://${info.host}:${info.port}/${info.database}`, importedAt: new Date().toISOString() };
    return dict;
  } finally {
    await pool.close();
  }
}

async function introspectOracle(info: DbConnInfo, password: string): Promise<DictionaryModel> {
  const oracledb = await import('oracledb');
  oracledb.default.outFormat = oracledb.default.OUT_FORMAT_OBJECT;
  const conn = await oracledb.default.getConnection({
    user: info.user, password, connectString: `${info.host}:${info.port}/${info.database}`,
  });
  try {
    const owner = info.user.toUpperCase();
    const dict = emptyDictionary(`${info.host}:${info.port}/${info.database}`, 'oracle');
    const tables = (await conn.execute(`
      SELECT t.table_name "n", c.comments "c"
      FROM all_tables t LEFT JOIN all_tab_comments c ON c.owner = t.owner AND c.table_name = t.table_name
      WHERE t.owner = :owner ORDER BY t.table_name`, [owner])).rows as any[];
    for (const t of tables) {
      const table: TableDef = { name: t.n, comment: t.c || undefined, columns: [], indexes: [], foreignKeys: [] };
      const cols = (await conn.execute(`
        SELECT col.column_name "n",
          col.data_type || CASE
            WHEN col.data_type IN ('VARCHAR2','VARCHAR','CHAR','NCHAR','NVARCHAR2') THEN '(' || col.char_length || ')'
            WHEN col.data_type IN ('NUMBER','FLOAT') AND col.data_precision IS NOT NULL THEN '(' || col.data_precision || ',' || COALESCE(col.data_scale, 0) || ')'
            ELSE '' END "ty",
          CASE WHEN col.nullable = 'Y' THEN 'YES' ELSE 'NO' END "nu",
          col.data_default "d",
          cc.comments "cmt"
        FROM all_tab_columns col
        LEFT JOIN all_col_comments cc ON cc.owner = col.owner AND cc.table_name = col.table_name AND cc.column_name = col.column_name
        WHERE col.owner = :owner AND col.table_name = :tn ORDER BY col.column_id`,
        { owner, tn: t.n })).rows as any[];
      const pkRows = (await conn.execute(`
        SELECT ucc.column_name "n"
        FROM all_constraints uc JOIN all_cons_columns ucc ON ucc.owner = uc.owner AND ucc.constraint_name = uc.constraint_name
        WHERE uc.owner = :owner AND uc.table_name = :tn AND uc.constraint_type = 'P'`,
        { owner, tn: t.n })).rows as any[];
      const pkSet = new Set(pkRows.map((r: any) => String(r.n)));
      for (const c of cols) {
        table.columns.push({
          name: c.n, type: c.ty, nullable: c.nu === 'YES', pk: pkSet.has(String(c.n)),
          defaultValue: c.d ? String(c.d).trim() : undefined, comment: c.cmt || undefined,
        });
      }
      const idx = (await conn.execute(`
        SELECT i.index_name "n", CASE WHEN i.uniqueness = 'UNIQUE' THEN 1 ELSE 0 END "u",
          LISTAGG(ic.column_name, ',') WITHIN GROUP (ORDER BY ic.column_position) "cols"
        FROM all_indexes i JOIN all_ind_columns ic ON ic.index_name = i.index_name AND ic.index_owner = i.owner
        WHERE i.table_owner = :owner AND i.table_name = :tn AND i.index_name NOT IN
          (SELECT constraint_name FROM all_constraints WHERE owner = :owner AND constraint_type = 'P' AND table_name = :tn)
        GROUP BY i.index_name, i.uniqueness ORDER BY i.index_name`,
        { owner, tn: t.n })).rows as any[];
      for (const i of idx) {
        table.indexes.push({ name: i.n, unique: !!i.u, columns: String(i.cols).split(',') });
      }
      const fks = (await conn.execute(`
        SELECT uc.constraint_name "n", ucc.column_name "col", ruc.table_name "rt", rcc.column_name "rc"
        FROM all_constraints uc
        JOIN all_cons_columns ucc ON ucc.constraint_name = uc.constraint_name AND ucc.owner = uc.owner
        JOIN all_constraints ruc ON ruc.owner = uc.r_owner AND ruc.constraint_name = uc.r_constraint_name
        JOIN all_cons_columns rcc ON rcc.constraint_name = ruc.constraint_name AND rcc.owner = ruc.owner AND rcc.position = ucc.position
        WHERE uc.owner = :owner AND uc.table_name = :tn AND uc.constraint_type = 'R'
        ORDER BY uc.constraint_name, ucc.position`,
        { owner, tn: t.n })).rows as any[];
      const fkMap = new Map<string, { cols: string[]; rt: string; rc: string[] }>();
      for (const f of fks) {
        const e: { cols: string[]; rt: string; rc: string[] } = fkMap.get(f.n) || { cols: [], rt: f.rt, rc: [] };
        e.cols.push(f.col);
        e.rc.push(f.rc);
        fkMap.set(f.n, e);
      }
      for (const [n, e] of fkMap) {
        table.foreignKeys.push({ name: n, columns: e.cols, refTable: e.rt, refColumns: e.rc });
      }
      dict.tables.push(table);
    }
    dict.meta = { source: `oracle://${info.host}:${info.port}/${info.database}`, importedAt: new Date().toISOString() };
    return dict;
  } finally {
    await conn.close();
  }
}
