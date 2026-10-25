import { describe, it, expect } from 'vitest';
import { detectTimestamp, formatMillis, relativeTime, parseDateInTz, batchConvert, nowByUnit } from '../src/logic/timestamp';
import { analyzeCron, buildCron, CRON_TEMPLATES } from '../src/logic/cronx';
import { tokenizeShell, parseCurl, generateCode } from '../src/logic/curlx';
import { parseInserts, generateUpdates, toCsv, splitToSingleRowInserts } from '../src/logic/sqlrestore';
import { repairJson, parseJsonLoose, generateTypes, jsonPath, toYaml, csvToJson, toCsv as jsonToCsv } from '../src/logic/jsonx';
import { runRegex, explainRegex } from '../src/logic/regexx';
import { buildDiffPairs, changedBlocks } from '../src/logic/diffx';
import { javaToJson, parseJavaClasses } from '../src/logic/javajson';

describe('timestamp', () => {
  it('按位数识别单位', () => {
    expect(detectTimestamp('1767225600')!.unit).toBe('s');
    expect(detectTimestamp('1767225600123')!.unit).toBe('ms');
    expect(detectTimestamp('1767225600123456')!.unit).toBe('us');
    expect(detectTimestamp('1767225600123456789')!.unit).toBe('ns');
    expect(detectTimestamp('abc')).toBeNull();
  });
  it('毫秒 → 秒换算一致', () => {
    expect(detectTimestamp('1767225600')!.millis).toBe(1767225600000);
    expect(detectTimestamp('1767225600123')!.millis).toBe(1767225600123);
  });
  it('时区格式化', () => {
    expect(formatMillis(1767225600000, 'UTC')).toBe('2026-01-01 00:00:00');
    expect(formatMillis(1767225600000, 'Asia/Shanghai')).toBe('2026-01-01 08:00:00');
  });
  it('相对时间', () => {
    const now = Date.parse('2026-01-10T00:00:00Z');
    expect(relativeTime(now - 3 * 86400000, now)).toBe('3 天前');
    expect(relativeTime(now + 2 * 3600000, now)).toBe('2 小时后');
  });
  it('日期串按时区解析', () => {
    expect(parseDateInTz('2026-01-01 08:00:00', 'Asia/Shanghai')).toBe(1767225600000);
    expect(parseDateInTz('2026-01-01 00:00:00', 'UTC')).toBe(1767225600000);
  });
  it('批量提取文本中的时间戳', () => {
    const out = batchConvert('log ts=1767225600 end 1767225600123 again 1767225600', 'UTC');
    expect(out.length).toBe(2);
  });
  it('当前时间各单位', () => {
    expect(nowByUnit('s')).toMatch(/^\d{10}$/);
    expect(nowByUnit('ns')).toMatch(/^\d{19}$/);
  });
});

describe('cron', () => {
  it('解析并给出中文描述与未来时间', () => {
    const r = analyzeCron('30 9 * * 1-5', 'Asia/Shanghai', 3, new Date('2026-01-05T00:00:00Z'));
    expect(r.ok).toBe(true);
    expect(r.nextRuns.length).toBe(3);
    expect(r.nextRuns[0]).toContain('09:30:00');
    expect(r.description).toContain('星期');
  });
  it('非法表达式报错', () => {
    const r = analyzeCron('not a cron', 'UTC');
    expect(r.ok).toBe(false);
    expect(r.error).toBeTruthy();
  });
  it('生成器拼接', () => {
    expect(buildCron({ minutes: '0', hours: '2', daysOfMonth: '*', months: '*', daysOfWeek: '1' })).toBe('0 2 * * 1');
    expect(CRON_TEMPLATES.length).toBeGreaterThan(5);
  });
});

describe('curl', () => {
  it('shell 分词', () => {
    expect(tokenizeShell(`curl -H "A: b c" -d 'x=1' https://e.com`)).toEqual(['curl', '-H', 'A: b c', '-d', 'x=1', 'https://e.com']);
  });
  it('解析多行续行命令', () => {
    const p = parseCurl(`curl -X POST 'https://api.x/v1' \\
  -H 'Content-Type: application/json' \\
  -H 'Authorization: Bearer t' \\
  -d '{"a":1}'`);
    expect(p.method).toBe('POST');
    expect(p.url).toBe('https://api.x/v1');
    expect(p.headers['Content-Type']).toBe('application/json');
    expect(p.body).toBe('{"a":1}');
  });
  it('GET 默认与 -u 认证', () => {
    const p = parseCurl('curl -u user:pass https://x.com');
    expect(p.method).toBe('GET');
    expect(p.headers['Authorization']).toMatch(/^Basic /);
  });
  it('--json 标志 (curl 7.82+)', () => {
    const p = parseCurl('curl --json \'{"name":"test"}\' https://api.x/v1');
    expect(p.method).toBe('POST');
    expect(p.headers['Content-Type']).toBe('application/json');
    expect(p.headers['Accept']).toBe('application/json');
    expect(p.body).toBe('{"name":"test"}');
  });
  it('代码生成', () => {
    const p = parseCurl('curl -X POST https://x.com -d a=1');
    expect(generateCode(p, 'python')).toContain('requests.post');
    expect(generateCode(p, 'go')).toContain('http.NewRequest');
    expect(generateCode(p, 'fetch')).toContain('fetch(');
  });
});

describe('sql restore', () => {
  const sql = `INSERT INTO t_user (id, name, remark, created) VALUES
    (1, '张三', NULL, NOW()),
    (2, 'it\\'s', 'a,b', '2026-01-01 10:00:00');`;
  it('解析多行 VALUES', () => {
    const { tables, errors } = parseInserts(sql);
    expect(errors).toEqual([]);
    expect(tables[0].table).toBe('t_user');
    expect(tables[0].columns).toEqual(['id', 'name', 'remark', 'created']);
    expect(tables[0].rows.length).toBe(2);
    expect(tables[0].rows[0][2]).toBe('NULL');
    expect(tables[0].rows[1][1]).toBe("it's");
  });
  it('生成 UPDATE', () => {
    const { tables } = parseInserts(sql);
    const ups = generateUpdates(tables[0], ['id']);
    expect(ups[0]).toContain('UPDATE `t_user` SET');
    expect(ups[0]).toContain('WHERE `id` = 1');
    expect(ups[0]).toContain('`remark` = NULL');
  });
  it('CSV 导出转义', () => {
    const { tables } = parseInserts(sql);
    const csv = toCsv(tables[0]);
    expect(csv.split('\n')[0]).toBe('id,name,remark,created');
    expect(csv).toContain('"a,b"');
  });
  it('拆单行 INSERT', () => {
    const { tables } = parseInserts(sql);
    const parts = splitToSingleRowInserts(tables[0]);
    expect(parts.length).toBe(2);
    expect(parts[0]).toMatch(/^INSERT INTO `t_user`.*VALUES \(1, '张三', NULL, NOW\(\)\);$/);
  });
});

describe('json', () => {
  it('修复单引号/注释/尾逗号/裸key', () => {
    const broken = `{
      // 行注释
      name: '张三',
      age: 18, /* 块注释 */
      tags: ['a', 'b',],
    }`;
    const r = parseJsonLoose(broken);
    expect(r.ok).toBe(true);
    expect(r.repaired).toBe(true);
    expect((r.data as any).name).toBe('张三');
    expect((r.data as any).tags).toEqual(['a', 'b']);
  });
  it('生成 TS/Java/Go/Kotlin', () => {
    const data = { id: 1, name: 'x', items: [{ sku_id: 'a', qty: 2 }], ok: true };
    const t = generateTypes(data, 'Root');
    expect(t.ts).toContain('interface Root');
    expect(t.ts).toContain('items: Item[]');
    expect(t.java).toContain('private List<Item>');
    expect(t.go).toContain('`json:"sku_id"`');
    expect(t.kotlin).toContain('data class Item');
  });
  it('JSONPath', () => {
    const data = { a: { b: [{ c: 1 }, { c: 2 }] } };
    expect(jsonPath(data, '$.a.b[1].c')).toEqual([2]);
    expect(jsonPath(data, '$["a"]["b"][0]["c"]')).toEqual([1]);
  });
  it('YAML/CSV 互转', () => {
    expect(toYaml({ a: 1 })).toContain('a: 1');
    expect(csvToJson('id,name\n1,张三\n2,李四')).toEqual([
      { id: 1, name: '张三' }, { id: 2, name: '李四' },
    ]);
    expect(jsonToCsv([{ a: 1, b: 'x,y' }])).toContain('"x,y"');
  });
});

describe('regex', () => {
  it('匹配与命名组', () => {
    const { matches, error } = runRegex('(?<y>\\d{4})-(\\d{2})', 'g', '2026-01 2025-12');
    expect(error).toBeUndefined();
    expect(matches.length).toBe(2);
    expect(matches[0].groups[0].name).toBe('y');
    expect(matches[0].text).toBe('2026-01');
  });
  it('解释基本表达式', () => {
    const ex = explainRegex('\\d+@[a-z]+');
    expect(ex.some((e) => e.meaning.includes('数字'))).toBe(true);
    expect(ex.some((e) => e.token === '@')).toBe(true);
  });
});

describe('diff', () => {
  it('行级配对与词级高亮', () => {
    const { pairs, stats } = buildDiffPairs('a\nb\nc', 'a\nB\nc');
    expect(stats.changed).toBe(1);
    const mod = pairs.find((p) => p.type === 'mod')!;
    expect(mod.left![0].changed).toBe(true);
    expect(mod.right![0].changed).toBe(true);
  });
  it('忽略大小写选项', () => {
    const { stats } = buildDiffPairs('Hello\nx', 'hello\nx', { ignoreCase: true });
    expect(stats.changed).toBe(0);
  });
  it('差异块提取', () => {
    const { pairs } = buildDiffPairs('a\nb', 'a\nc');
    expect(changedBlocks(pairs, 'right')).toEqual(['c']);
  });
});

describe('java to json', () => {
  const src = `
  public class UserDTO {
    private Long id;
    @JsonProperty("user_name")
    private String userName;
    @JsonIgnore
    private String secret;
    private List<OrderDTO> orders;
    private Map<String, Integer> counts;
    private Status status;
    public enum Status { ACTIVE, BANNED }
  }
  class OrderDTO { private String orderNo; private BigDecimal amount; }`;

  it('解析字段与注解', () => {
    const classes = parseJavaClasses(src);
    expect(classes.has('UserDTO')).toBe(true);
    const f = classes.get('UserDTO')!.fields;
    expect(f.find((x) => x.name === 'userName')!.jsonName).toBe('user_name');
    expect(f.find((x) => x.name === 'secret')!.ignored).toBe(true);
  });
  it('生成示例 JSON 含泛型/枚举/嵌套', () => {
    const r = javaToJson(src);
    expect(r.error).toBeUndefined();
    const obj = JSON.parse(r.json);
    expect(obj.user_name).toBe('示例文本');
    expect(obj.secret).toBeUndefined();
    expect(Array.isArray(obj.orders)).toBe(true);
    expect(obj.orders[0].orderNo).toBeTruthy();
    expect(obj.status).toBe('ACTIVE');
    expect(typeof obj.counts).toBe('object');
  });
});
