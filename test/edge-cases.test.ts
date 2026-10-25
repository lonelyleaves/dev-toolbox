import { describe, it, expect } from 'vitest';
import { parseCurl, generateCode } from '../src/logic/curlx';
import { repairJson, parseJsonLoose, toXml, toCsv, csvToJson, jsonPath } from '../src/logic/jsonx';
import { detectTimestamp, formatMillis, batchConvert, nowByUnit, parseDateInTz } from '../src/logic/timestamp';
import { exportHtml, exportMermaid, dictStats, dictSearch, referrersOf, buildExcelSheets } from '../src/dictionary/exporters';
import { emptyDictionary, DictionaryModel } from '../src/dictionary/model';

describe('curl --json 标志 (curl 7.82+)', () => {
  it('--json 自动设置 Content-Type 和 Accept', () => {
    const p = parseCurl('curl --json \'{"name":"test"}\' https://api.x/v1');
    expect(p.method).toBe('POST');
    expect(p.headers['Content-Type']).toBe('application/json');
    expect(p.headers['Accept']).toBe('application/json');
    expect(p.body).toBe('{"name":"test"}');
  });
  it('--json 与 -X 组合', () => {
    const p = parseCurl('curl -X PUT --json \'{"id":1}\' https://api.x/v1/1');
    expect(p.method).toBe('PUT');
    expect(p.headers['Content-Type']).toBe('application/json');
  });
});

describe('JSON 工具箱边界条件', () => {
  it('空输入', () => {
    expect(parseJsonLoose('').ok).toBe(false);
    expect(repairJson('')).toBe('');
  });
  it('深层嵌套对象', () => {
    const deep = JSON.stringify({ a: { b: { c: { d: { e: 1 } } } } });
    expect(parseJsonLoose(deep).ok).toBe(true);
  });
  it('toXml 转义特殊字符', () => {
    const xml = toXml({ name: '<script>alert("xss")</script>' });
    expect(xml).toContain('&lt;script&gt;');
    expect(xml).not.toContain('<script>');
  });
  it('toCsv 处理嵌套对象', () => {
    const csv = toCsv([{ a: 1, b: { nested: true } }]);
    expect(csv).toContain('"nested"');
  });
  it('csvToJson 类型推断', () => {
    const data = csvToJson('id,name,active\n1,test,true\n2,other,false');
    expect(data).toEqual([
      { id: 1, name: 'test', active: true },
      { id: 2, name: 'other', active: false },
    ]);
  });
  it('jsonPath 数组通配', () => {
    const data = { items: [{ id: 1 }, { id: 2 }, { id: 3 }] };
    expect(jsonPath(data, '$.items[0].id')).toEqual([1]);
  });
});

describe('时间戳边界条件', () => {
  it('负数时间戳（1970 年之前）', () => {
    const det = detectTimestamp('-1000000000');
    // 负数不在正则范围内，应返回 null
    expect(det).toBeNull();
  });
  it('极大时间戳', () => {
    const det = detectTimestamp('9999999999999');
    expect(det).not.toBeNull();
    expect(det!.unit).toBe('ms');
  });
  it('formatMillis 无效输入', () => {
    expect(formatMillis(NaN, 'UTC')).toBe('无效时间');
    expect(formatMillis(Infinity, 'UTC')).toBe('超出可表示范围');
  });
  it('parseDateInTz 各种格式', () => {
    expect(parseDateInTz('2026-01-01', 'UTC')).toBe(1767225600000);
    expect(parseDateInTz('invalid', 'UTC')).toBeNull();
  });
  it('batchConvert 无重复', () => {
    const out = batchConvert('ts=1767225600 again 1767225600', 'UTC');
    expect(out.length).toBe(1); // 去重
  });
});

describe('导出器边界条件', () => {
  function makeDict(): DictionaryModel {
    const d = emptyDictionary('test', 'mysql');
    d.tables.push({
      name: 't_user',
      comment: '用户表',
      columns: [
        { name: 'id', type: 'bigint', pk: true, nullable: false },
        { name: 'name', type: 'varchar(32)', nullable: true, comment: '姓名' },
      ],
      indexes: [{ name: 'idx_name', unique: false, columns: ['name'] }],
      foreignKeys: [],
    });
    return d;
  }

  it('HTML 导出含样式', () => {
    const html = exportHtml(makeDict());
    expect(html).toContain('<!DOCTYPE html>');
    expect(html).toContain('t_user');
    expect(html).toContain('用户表');
  });
  it('Mermaid 导出含关系', () => {
    const d = makeDict();
    d.tables.push({
      name: 't_order',
      columns: [{ name: 'user_id', type: 'bigint' }],
      indexes: [],
      foreignKeys: [{ name: 'fk_user', columns: ['user_id'], refTable: 't_user', refColumns: ['id'] }],
    });
    const mmd = exportMermaid(d);
    expect(mmd).toContain('erDiagram');
    expect(mmd).toContain('t_user ||--o{ t_order');
  });
  it('dictStats 类型分布', () => {
    const stats = dictStats(makeDict());
    expect(stats.tables).toBe(1);
    expect(stats.columns).toBe(2);
    expect(stats.commentedColumns).toBe(1);
    expect(stats.typeDist.length).toBeGreaterThan(0);
  });
  it('dictSearch 大小写不敏感', () => {
    const hits = dictSearch(makeDict(), 'USER');
    expect(hits.length).toBeGreaterThan(0);
  });
  it('buildExcelSheets 含总览', () => {
    const sheets = buildExcelSheets(makeDict());
    expect(sheets[0].name).toBe('总览');
    expect(sheets.length).toBe(2); // 总览 + t_user
  });
  it('空字典导出', () => {
    const d = emptyDictionary('empty', 'generic');
    expect(dictStats(d).tables).toBe(0);
    expect(exportMermaid(d)).toBe('erDiagram');
  });
});
