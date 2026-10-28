import { describe, it, expect } from 'vitest';
// 直接走真实 kingdee 模块，mock 掉 vscode（它不 import 时不加载），但 login 走 doHttpRequest → http，
// 所以通过 vi.mock http.ts 来注入"登录成功但不发 Set-Cookie"的响应，验证警告文案与拉取行为
import { vi } from 'vitest';
import * as httpMod from '../src/host/http';
import { kingdeeTestProject, kingdeeFetchMetadata } from '../src/host/kingdee';

vi.mock('../src/host/http', () => ({
  doHttpRequest: vi.fn(),
}));
vi.mock('vscode', () => ({
  workspace: { getConfiguration: () => ({ get: () => undefined }) },
}));

/** 记录每次 HTTP 请求的 url 与 body，用于断言登录报文形态 */
const sent: { url: string; body: string }[] = [];

function mockLoginResponse(opts: { body?: string; setCookie?: string[] }) {
  (httpMod.doHttpRequest as any).mockImplementation(async (p: any) => {
    sent.push({ url: String(p.url), body: String(p.body ?? '') });
    if (String(p.url).includes('AuthService') || p.url.includes('ValidateUser')) {
      return {
        status: 200,
        bodyText: opts.body ?? '{"LoginResultType":1,"ErrMsg":"ok"}',
        headers: opts.setCookie ? { 'set-cookie': opts.setCookie } : {},
      };
    }
    // 元数据接口
    return {
      status: 200,
      bodyText: JSON.stringify([{ FormId: p.body?.FormId ?? 'BD_MATERIAL', Fields: [{ Key: 'Number', Name: '编码' }] }]),
      headers: {},
    };
  });
}

const pc: any = { baseUrl: 'http://erp.example.cn', dbId: 'db', appId: 'app', user: 'u', extraHeaders: '' };

describe('金蝶登录无会话 Cookie 的警告与数据链路', () => {
  it('登录成功但未返回 Set-Cookie 时：提示 ok 且给出 extraHeaders 警告文案', async () => {
    mockLoginResponse({});
    const r = await kingdeeTestProject(pc);
    expect(r.ok).toBe(true);
    expect(r.message).toContain('登录成功但未返回会话 Cookie');
    expect(r.message).toContain('extraHeaders');
  });

  it('登录带 Set-Cookie(kdservice-sessionid) 时：提示已取得会话', async () => {
    mockLoginResponse({ setCookie: ['kdservice-sessionid=abc123; Path=/; HttpOnly'] });
    const r = await kingdeeTestProject(pc);
    expect(r.ok).toBe(true);
    expect(r.message).toContain('已登录并取得会话');
  });

  it('拉取数据：无 Cookie 也发得出请求；Cookie 存在时元数据请求头里带 Cookie', async () => {
    mockLoginResponse({ setCookie: ['kdservice-sessionid=abc123; Path=/; HttpOnly'] });
    const r = await kingdeeFetchMetadata(['BD_MATERIAL'], { projectId: 'p1' }, undefined as any, (() => ({ connections: { kingdee: [pc] } })) as any);
    expect(r.ok).toBe(true);
    expect(r.text).toContain('BD_MATERIAL');
    // 找到发往元数据接口的那次请求，验证带上了 Cookie
    const calls = (httpMod.doHttpRequest as any).mock.calls;
    const metaCall = calls.find((c: any[]) => String(c[0].url).includes('QueryBusinessInfo') || !String(c[0].url).includes('ValidateUser'));
    expect(metaCall[0].headers.Cookie).toContain('kdservice-sessionid=abc123');

    // 再测无 Cookie 场景：元数据请求头不带 Cookie，但请求照样发出并解析
    mockLoginResponse({});
    (httpMod.doHttpRequest as any).mockClear();
    const r2 = await kingdeeFetchMetadata(['BD_MATERIAL'], { projectId: 'p1' }, undefined as any, (() => ({ connections: { kingdee: [pc] } })) as any);
    expect(r2.ok).toBe(true);
    const calls2 = (httpMod.doHttpRequest as any).mock.calls;
    const metaCall2 = calls2.find((c: any[]) => !String(c[0].url).includes('ValidateUser'));
    expect(metaCall2[0].headers.Cookie ?? '').toBe('');
  });

  it('登录明确失败(LoginResultType=0)且无 Cookie 时抛错', async () => {
    mockLoginResponse({ body: '{"LoginResultType":0,"ErrMsg":"user not found"}' });
    const r = await kingdeeTestProject(pc);
    expect(r.ok).toBe(false);
    expect(r.message).toContain('登录失败');
  });

  it('拉取时服务端 401/403：返回带排查指引的失败，而不是把裸报文当数据', async () => {
    mockLoginResponse({});
    (httpMod.doHttpRequest as any).mockImplementation(async (p: any) => {
      if (String(p.url).includes('ValidateUser')) {
        return { status: 200, bodyText: '{"LoginResultType":1}', headers: {} };
      }
      return { status: 401, bodyText: 'unauthorized', headers: {} };
    });
    const r = await kingdeeFetchMetadata(['BD_MATERIAL'], { projectId: 'p1' }, undefined as any, (() => ({ connections: { kingdee: [pc] } })) as any);
    expect(r.ok).toBe(false);
    expect(r.error).toContain('鉴权被拒（HTTP 401）');
    expect(r.error).toContain('附加请求头');
  });

  it('登录请求体是官方命名对象（密码模式 ValidateUser）', async () => {
    sent.length = 0;
    mockLoginResponse({});
    await kingdeeFetchMetadata(['BD_MATERIAL'], { projectId: 'p1', password: 'pwd' }, undefined as any, (() => ({ connections: { kingdee: [pc] } })) as any);
    const req = sent.find((r) => r.url.includes('ValidateUser'))!;
    expect(req).toBeTruthy();
    const body = JSON.parse(req.body);
    expect(Array.isArray(body)).toBe(false);
    expect(body).toEqual({ acctID: pc.dbId, username: pc.user, password: 'pwd', lcid: 2052 });
  });

  it('有 appSecret 且无密码时：走 LoginByAppSecret，parameters 为 JSON 字符串', async () => {
    sent.length = 0;
    mockLoginResponse({});
    await kingdeeFetchMetadata(['BD_MATERIAL'], { projectId: 'p1', appSecret: 'sec' }, undefined as any, (() => ({ connections: { kingdee: [pc] } })) as any);
    const req = sent.find((r) => r.url.includes('LoginByAppSecret'))!;
    expect(req).toBeTruthy();
    const body = JSON.parse(req.body);
    expect(body.format).toBe(1);
    expect(typeof body.parameters).toBe('string');
    expect(JSON.parse(body.parameters)).toEqual([pc.dbId, pc.user, pc.appId, 'sec', 2052]);
  });

  it('元数据请求体是官方 { parameters: [{ FormId }] }', async () => {
    sent.length = 0;
    mockLoginResponse({});
    await kingdeeFetchMetadata(['BD_MATERIAL'], { projectId: 'p1', password: 'pwd' }, undefined as any, (() => ({ connections: { kingdee: [pc] } })) as any);
    const req = sent.find((r) => r.url.includes('QueryBusinessInfo'))!;
    expect(req).toBeTruthy();
    const body = JSON.parse(req.body);
    expect(body.parameters).toEqual([{ FormId: 'BD_MATERIAL' }]);
  });
});
