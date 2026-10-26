import { describe, it, expect } from 'vitest';
import { normalizeInput, toSingleLine } from '../src/logic/text';
import { parseJsonLoose } from '../src/logic/jsonx';
import { parseCurl, prepareCurlCommand } from '../src/logic/curlx';
import { detectTimestamp, parseDateInTz } from '../src/logic/timestamp';
import { decodeJwt } from '../src/logic/encodex';

describe('粘贴内容归一化', () => {
  it('去掉 BOM、零宽字符，CRLF 转 LF', () => {
    expect(normalizeInput('\uFEFF{"a":1}\u200B\r\n')).toBe('{"a":1}\n');
    expect(normalizeInput('a\rb')).toBe('a\nb');
  });

  it('单行输入：换行/制表/连续空格压成一个空格', () => {
    expect(toSingleLine(' 0 9  * *\n1-5\t ')).toBe('0 9 * * 1-5');
  });

  it('JSON：带 BOM 和尾换行也能解析', () => {
    const r = parseJsonLoose('\uFEFF{"a":1}\r\n');
    expect(r.ok).toBe(true);
    expect((r as any).data).toEqual({ a: 1 });
  });

  it('时间戳：带 BOM / 换行仍能识别', () => {
    const d = detectTimestamp('\uFEFF1730000000000\r\n');
    expect(d?.unit).toBe('ms');
    expect(d?.millis).toBe(1730000000000);
  });

  it('日期输入：带换行也能解析', () => {
    expect(parseDateInTz('2026-01-31 12:00:00\n', 'Asia/Shanghai')).toBe(
      Date.parse('2026-01-31T12:00:00+08:00'),
    );
  });

  it('JWT：支持 Bearer 前缀与被终端折行', () => {
    const seg = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url');
    const token = `${seg({ alg: 'HS256', typ: 'JWT' })}.${seg({ sub: '1', name: '张三' })}.sig`;
    for (const input of [`Bearer ${token}`, token.replace(/\./g, '\n.'), token]) {
      const r = decodeJwt(input);
      expect(r.payload).toEqual({ sub: '1', name: '张三' });
      expect(r.header.alg).toBe('HS256');
    }
  });

  it('JWT 非 3 段仍然报错', () => {
    expect(() => decodeJwt('abc')).toThrow('3 段');
  });
});

describe('cURL 多行 / 续行符', () => {
  it('bash 反斜杠续行', () => {
    const cmd = `curl -X POST \\
  -H 'Content-Type: application/json' \\
  -d '{"a":1}' \\
  https://api.x/v1`;
    const p = parseCurl(cmd);
    expect(p.method).toBe('POST');
    expect(p.body).toBe('{"a":1}');
    expect(p.url).toBe('https://api.x/v1');
  });

  it('PowerShell 反引号续行', () => {
    const cmd = 'curl -X PUT `\n  -H "Accept: application/json" `\n  https://api.x/v2';
    const p = parseCurl(cmd);
    expect(p.method).toBe('PUT');
    expect(p.headers['Accept']).toBe('application/json');
    expect(p.url).toBe('https://api.x/v2');
  });

  it('cmd.exe 脱字符续行与 ^" 转义引号', () => {
    const cmd = 'curl.exe -X POST ^\n  -H ^"Content-Type: application/json^" ^\n  -d "{\\"a\\":1}" ^\n  https://api.x/v3';
    const p = parseCurl(cmd);
    expect(p.method).toBe('POST');
    expect(p.headers['Content-Type']).toBe('application/json');
    expect(p.body).toBe('{"a":1}');
    expect(p.url).toBe('https://api.x/v3');
  });

  it('prepareCurlCommand：CRLF 与续行统一', () => {
    for (const raw of ['curl \\\r\n  https://x', 'curl ^\r\n  https://x', 'curl `\r\n  https://x']) {
      const out = prepareCurlCommand(raw);
      expect(out).not.toContain('\n');
      expect(out).not.toContain('\\');
      expect(out).not.toContain('^');
      expect(out).not.toContain('`');
      expect(out).toContain('curl');
      expect(out).toContain('https://x');
    }
  });
});
