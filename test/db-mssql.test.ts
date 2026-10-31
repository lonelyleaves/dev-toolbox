import { describe, it, expect, vi } from 'vitest';

// mssql v11 API 变更回归锁定：
// input() 签名是 input(name, type, value)；旧写法 input(name, sql.NVarChar(x))
// 会把类型描述符当成 value 绑定，执行时 NVarChar.validate 抛 "Validation failed: Invalid string"
const ctx = vi.hoisted(() => ({ captured: [] as { name: string; value: unknown }[], sqls: [] as string[] }));

vi.mock('mssql', () => {
  const fakeReq: any = {
    input: (name: string, _type: unknown, value: unknown) => {
      ctx.captured.push({ name, value });
      return fakeReq;
    },
    query: async (sqlText: string) => {
      ctx.sqls.push(sqlText);
      return {
        recordset: sqlText.includes('FROM sys.tables t')
          ? [{ n: 'T_A', c: '表A' }, { n: 'T_B', c: undefined }]
          : sqlText.includes('FROM sys.columns c')
            ? [{ tn: 'T_A', n: 'F1', ty: 'nvarchar(50)', nu: 'YES', k: 'PRI', d: null, idn: 0, cmt: '列1' }]
            : sqlText.includes('FROM sys.indexes i')
              ? [{ tn: 'T_A', n: 'IX_1', u: 1, cols: 'F1' }]
              : [{ tn: 'T_A', n: 'FK_1', col: 'F1', rt: 'T_B', rc: 'F1' }],
      };
    },
  };
  const fakePool = { request: () => fakeReq, close: async () => {} };
  return {
    default: {
      connect: async () => fakePool,
      NVarChar: (len: number) => ({ type: 'NVARCHAR', length: len }),
    },
  };
});

describe('introspect mssql 批量查询（避免逐表 3 次查询超时）', () => {
  it('字段/索引/外键各一次查询，并按表名正确归表', async () => {
    ctx.captured.length = 0;
    ctx.sqls.length = 0;
    const { introspect } = await import('../src/host/db');
    const dict = await introspect(
      { client: 'mssql', host: 'prod.example.cn', port: 1433, user: 'sa', password: 'x', database: 'ERP_DB' } as any,
      { get: async () => null } as any,
    );
    // 已改为批量查询，不再逐表 input 绑定
    expect(ctx.captured.length).toBe(0);
    expect(ctx.sqls.filter((s) => s.includes('FROM sys.columns c')).length).toBe(1);
    expect(ctx.sqls.filter((s) => s.includes('FROM sys.indexes i')).length).toBe(1);
    expect(ctx.sqls.filter((s) => s.includes('FROM sys.foreign_keys fk')).length).toBe(1);

    expect(dict.tables.map((t) => t.name)).toEqual(['T_A', 'T_B']);
    expect(dict.tables[0].columns).toHaveLength(1);
    expect(dict.tables[0].columns[0].name).toBe('F1');
    expect(dict.tables[0].indexes[0].name).toBe('IX_1');
    expect(dict.tables[0].foreignKeys[0].refTable).toBe('T_B');
  });

  it('主键判定用 EXISTS，不再有重名列派生表（回归：column_id specified multiple times）', async () => {
    ctx.sqls.length = 0;
    const { introspect } = await import('../src/host/db');
    await introspect(
      { client: 'mssql', host: 'h', port: 1433, user: 'sa', password: 'x', database: 'db' } as any,
      { get: async () => null } as any,
    );
    const colSql = ctx.sqls.find((s) => s.includes('FROM sys.columns c')) || '';
    expect(colSql.length).toBeGreaterThan(0);
    // 旧写法在派生表 kc 里重复 column_id，SQL Server 直接报错
    expect(colSql).not.toMatch(/MIN\s*\(\s*ic2\.column_id\s*\)\s*column_id/i);
    expect(colSql).not.toContain('kc.column_id');
    // 新写法：EXISTS + is_primary_key
    expect(colSql).toMatch(/EXISTS\s*\(/i);
    expect(colSql).toMatch(/is_primary_key\s*=\s*1/i);
  });
});
