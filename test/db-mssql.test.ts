import { describe, it, expect, vi } from 'vitest';

// mssql v11 API 变更回归锁定：
// input() 签名是 input(name, type, value)；旧写法 input(name, sql.NVarChar(x))
// 会把类型描述符当成 value 绑定，执行时 NVarChar.validate 抛 "Validation failed: Invalid string"
const ctx = vi.hoisted(() => ({ captured: [] as { name: string; value: unknown }[] }));

vi.mock('mssql', () => {
  const fakeReq: any = {
    input: (name: string, _type: unknown, value: unknown) => {
      ctx.captured.push({ name, value });
      return fakeReq;
    },
    query: async (sqlText: string) => ({
      recordset: sqlText.includes('FROM sys.tables t')
        ? [{ n: 'T_A', c: '表A' }, { n: 'T_B', c: undefined }]
        : sqlText.includes('FROM sys.columns c')
          ? [{ n: 'F1', ty: 'nvarchar(50)', nu: 'YES', k: 'PRI', d: null, idn: 0, cmt: '列1' }]
          : sqlText.includes('FROM sys.indexes i')
            ? [{ n: 'IX_1', u: 1, cols: 'F1' }]
            : [{ n: 'FK_1', col: 'F1', rt: 'T_B', rc: 'F1' }],
    }),
  };
  const fakePool = { request: () => fakeReq, close: async () => {} };
  return {
    default: {
      connect: async () => fakePool,
      NVarChar: (len: number) => ({ type: 'NVARCHAR', length: len }),
    },
  };
});

describe('introspect mssql 参数绑定（mssql v11 三参 input）', () => {
  it('tn 参数值必须是字符串（不再把 NVarChar 描述符当值绑定）', async () => {
    const { introspect } = await import('../src/host/db');
    const dict = await introspect(
      { client: 'mssql', host: 'prod.example.cn', port: 1433, user: 'sa', password: 'x', database: 'ERP_DB' } as any,
      { get: async () => null } as any,
    );
    expect(ctx.captured.map((c) => c.name)).toEqual(['tn', 'tn', 'tn', 'tn', 'tn', 'tn']);
    for (const c of ctx.captured) {
      expect(typeof c.value).toBe('string');
      expect(['T_A', 'T_B']).toContain(c.value);
    }
    expect(dict.tables.map((t) => t.name)).toEqual(['T_A', 'T_B']);
    expect(dict.tables[0].columns).toHaveLength(1);
    expect(dict.tables[0].indexes[0].name).toBe('IX_1');
    expect(dict.tables[0].foreignKeys[0].refTable).toBe('T_B');
  });
});
