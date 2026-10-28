/**
 * 金蝶云星空 WebAPI 客户端。
 *
 * 【待确认】金蝶各版本/部署的接口名与报文结构存在差异，这里把关键部分做成可配置：
 *   - devToolbox.kingdee.baseUrl      站点地址，如 http://xxx/k3cloud
 *   - devToolbox.kingdee.loginPath    登录接口路径
 *   - devToolbox.kingdee.metadataPath 元数据接口路径
 *   - devToolbox.kingdee.argStyle     参数风格：parameters(数组) / named(对象)
 * 拿到贵司的接口文档后只需改配置或直接替换本文件的两处请求体构造。
 * 凭据（appSecret / 密码）只存 context.secrets，不进项目文件与导出包。
 */
import * as vscode from 'vscode';
import { doHttpRequest } from './http';
import { KingdeeConnectionConfig, ProjectConfig, findKingdeeConfig } from '../core/messaging';
import { projectSecretKey } from './project-store';

export interface KingdeeConfig {
  baseUrl: string;
  dbId: string;
  appId: string;
  appSecret: string;
  user: string;
  password: string;
  lcid?: number;
  loginPath?: string;
  metadataPath?: string;
  argStyle?: 'parameters' | 'named';
  extraHeaders?: Record<string, string>;
}

export interface KingdeeFetchResult {
  ok: boolean;
  /** 原始报文（交给 webview 侧的 parseKingdeeMetadata 解析） */
  text?: string;
  error?: string;
}

// 官方形态（金蝶云星空 WebAPI，已核对公开文档）：
//   登录：/K3Cloud/Kingdee.BOS.WebApi.ServicesStub.AuthService.ValidateUser.common.kdsvc
//         参数 [acctID(数据中心ID), username, password, lcid]
//   会话：登录响应 Set-Cookie 里的 kdservice-sessionid，后续接口带在 Cookie 上
//   元数据：/K3Cloud/Kingdee.BOS.WebApi.ServicesStub.DynamicFormService.QueryBusinessInfo.common.kdsvc
//         请求体 { "FormId": "BD_MATERIAL" }
const DEFAULT_LOGIN_PATH = 'Kingdee.BOS.WebApi.ServicesStub.AuthService.ValidateUser.common.kdsvc';
/** 应用鉴权登录（第三方应用 appId/appSecret）：参数 [acctID, userName, appId, appSecret, lcid] */
const DEFAULT_LOGIN_BY_APPSECRET_PATH = 'Kingdee.BOS.WebApi.ServicesStub.AuthService.LoginByAppSecret.common.kdsvc';
const DEFAULT_METADATA_PATH = 'Kingdee.BOS.WebApi.ServicesStub.DynamicFormService.QueryBusinessInfo.common.kdsvc';

function joinUrl(base: string, path: string): string {
  return `${base.replace(/\/+$/, '')}/${path.replace(/^\/+/, '')}`;
}

/** 读全局 devToolbox.kingdee.* 设置：仅用于往项目配置里"填充默认值"，运行时不再读取 */
export function globalKingdeeDefaults(): KingdeeConnectionConfig {
  const c = readCfg();
  return {
    baseUrl: c.baseUrl || undefined,
    dbId: c.dbId || undefined,
    appId: c.appId || undefined,
    user: c.user || undefined,
    lcid: c.lcid,
    // 只带用户显式配置的路径：默认路径由运行时回落，写进来会改变指纹，
    // 导致"什么都没改却被判定为连接已变更"
    loginPath: c.loginPath && c.loginPath !== DEFAULT_LOGIN_PATH ? c.loginPath : undefined,
    metadataPath: c.metadataPath && c.metadataPath !== DEFAULT_METADATA_PATH ? c.metadataPath : undefined,
    argStyle: c.argStyle,
    extraHeaders: c.extraHeaders && Object.keys(c.extraHeaders).length ? JSON.stringify(c.extraHeaders) : undefined,
  };
}

function readCfg() {
  const cfg = vscode.workspace.getConfiguration('devToolbox.kingdee');
  let extraHeaders: Record<string, string> = {};
  try {
    const raw = String(cfg.get('extraHeaders') || '').trim();
    if (raw) extraHeaders = JSON.parse(raw);
  } catch { extraHeaders = {}; }
  return {
    baseUrl: String(cfg.get('baseUrl') || ''),
    dbId: String(cfg.get('dbId') || ''),
    appId: String(cfg.get('appId') || ''),
    user: String(cfg.get('user') || ''),
    lcid: Number(cfg.get('lcid') ?? 2052),
    loginPath: String(cfg.get('loginPath') || DEFAULT_LOGIN_PATH),
    metadataPath: String(cfg.get('metadataPath') || DEFAULT_METADATA_PATH),
    argStyle: (String(cfg.get('argStyle') || 'named') as 'parameters' | 'named'),
    extraHeaders,
  };
}

/** 从 Set-Cookie 里取出会话 id（金蝶用 kdservice-sessionid 维持会话） */
function pickSessionCookie(setCookie: string | string[] | undefined): string {
  const list = Array.isArray(setCookie) ? setCookie : setCookie ? [setCookie] : [];
  let session = '';
  let all: string[] = [];
  for (const c of list) {
    for (const part of c.split(/,(?=[^;]+=)/)) {
      const kv = part.split(';')[0].trim();
      if (!kv) continue;
      all.push(kv);
      if (kv.toLowerCase().startsWith('kdservice-sessionid=')) session = kv;
    }
  }
  return session || all.join('; ');
}

export const KINGDEE_SECRET_KEY = 'kingdee.credentials';

export async function loadSecret(secrets: vscode.SecretStorage, projectId?: string, configId?: string): Promise<{ appSecret?: string; password?: string }> {
  try {
    const raw = await secrets.get(projectId ? projectSecretKey(projectId, 'kingdee', configId) : KINGDEE_SECRET_KEY);
    return raw ? JSON.parse(raw) : {};
  } catch {
    return {};
  }
}

export async function saveSecret(secrets: vscode.SecretStorage, appSecret?: string, password?: string, projectId?: string, configId?: string) {
  const cur = await loadSecret(secrets, projectId, configId);
  await secrets.store(projectId ? projectSecretKey(projectId, 'kingdee', configId) : KINGDEE_SECRET_KEY, JSON.stringify({
    appSecret: appSecret ?? cur.appSecret ?? '',
    password: password ?? cur.password ?? '',
  }));
}

/**
 * 登录，返回会话 Cookie（金蝶 WebAPI 用 Cookie 维持会话）。
 * 官方两种报文形态：
 * - 账号密码（ValidateUser）：命名对象 { acctID, username, password, lcid }
 * - 第三方应用（LoginByAppSecret）：包装对象 { format, useragent, rid, parameters(JSON 字符串), timestamp, v }
 * 注意：不要直接把裸数组当作请求体，部分部署会反序列化失败（Additional text found in JSON string）。
 */
async function login(cfg: KingdeeConfig): Promise<string> {
  const lcid = cfg.lcid ?? 2052;
  const useApp = !cfg.password && !!cfg.appSecret;
  const url = joinUrl(cfg.baseUrl, useApp ? DEFAULT_LOGIN_BY_APPSECRET_PATH : (cfg.loginPath || DEFAULT_LOGIN_PATH));
  const params = useApp
    ? [cfg.dbId, cfg.user, cfg.appId, cfg.appSecret, lcid]
    : [cfg.dbId, cfg.user, cfg.password, lcid];
  const body = useApp
    ? {
        format: 1,
        useragent: 'ApiClient',
        rid: Math.random().toString(36).slice(2) + Date.now().toString(36),
        parameters: JSON.stringify(params), // 官方要求：数组先序列化成字符串，再放在 parameters 里
        timestamp: new Date().toISOString(),
        v: '1.0',
      }
    : { acctID: cfg.dbId, username: cfg.user, password: cfg.password, lcid };
  const res = await doHttpRequest({
    url,
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    timeoutMs: 20000,
  } as any);
  const cookie = pickSessionCookie(res.headers?.['set-cookie'] ?? (res.headers as any)?.['Set-Cookie']);
  const text = String(res.bodyText ?? '');
  // 401/403 常见于：WebAPI 未启用 / 账号无 Web API 授权 / 第三方登录授权未启用或被禁用 / IP 白名单
  if (res.status === 401 || res.status === 403) {
    throw new Error(
      `登录被拒（HTTP ${res.status}）${text ? '：' + text.slice(0, 300) : '，响应为空'}。` +
      '排查：① 站点是否已启用 WebAPI；② 账号是否被授权使用 Web API（多数需系统管理员在「公共设置 → Web API」授权）；' +
      '③ 若用 appId/appSecret，确认「第三方登录授权」已启用且未禁用；④ 是否有 IP 白名单限制；⑤ baseUrl 是否正确（一般形如 http://server/k3cloud）'
    );
  }
  if (res.status >= 400) {
    throw new Error(`登录失败（HTTP ${res.status}）${text ? '：' + text.slice(0, 300) : ''}`);
  }
  // LoginResultType: 1 表示成功（0 失败/-1 账套不存在等）
  if (text && !/LoginResultType["'\s:]+1/.test(text)) {
    throw new Error(`登录失败：${text.slice(0, 300)}`);
  }
  return cookie;
}

/**
 * 拉取指定表单的元数据，返回原始报文文本。
 * 解析交给 webview 侧的 parseKingdeeMetadata，保持"取数"与"解析"分离（便于粘贴报文复用解析）。
 */
/**
 * 拉取指定表单的元数据，返回原始报文文本。
 *
 * 连接信息**只来自项目配置**（ProjectConfig.connections.kingdee），凭据按项目存 SecretStorage：
 * 切换项目 = 切换 ERP 站点与账号，不同客户的库互不串。项目没配连接时直接拒绝，不去读全局设置。
 * 解析交给 webview 侧的 parseKingdeeMetadata，保持"取数"与"解析"分离（便于粘贴报文复用解析）。
 */
/** 项目配置 + 凭据 → 完整请求配置（路径等缺省值回落到全局设置） */
function buildKingdeeConfig(pc: KingdeeConnectionConfig, sec: { appSecret?: string; password?: string }): KingdeeConfig {
  const g = readCfg();
  return {
    baseUrl: pc.baseUrl || '',
    dbId: pc.dbId || '',
    appId: pc.appId || '',
    user: pc.user || '',
    appSecret: sec.appSecret || '',
    password: sec.password || '',
    lcid: pc.lcid ?? 2052,
    loginPath: pc.loginPath || g.loginPath || DEFAULT_LOGIN_PATH,
    metadataPath: pc.metadataPath || g.metadataPath || DEFAULT_METADATA_PATH,
    argStyle: pc.argStyle || g.argStyle || 'named',
    extraHeaders: pc.extraHeaders ? safeParseJson(pc.extraHeaders) : (g.extraHeaders || {}),
  };
}

/** 只验证"配的对不对"：登录一次拿到会话即可，不拉元数据 */
export async function kingdeeTestProject(
  pc: KingdeeConnectionConfig,
  secrets?: vscode.SecretStorage,
  projectId?: string,
  configId?: string,
): Promise<{ ok: boolean; message: string }> {
  try {
    if (!pc?.baseUrl) return { ok: false, message: '未填写站点地址（baseUrl）' };
    const sec = secrets && projectId ? await loadSecret(secrets, projectId, configId) : {};
    const cfg = buildKingdeeConfig(pc, sec);
    const cookie = await login(cfg);
    return {
      ok: true,
      message: cookie
        ? '配置可用：已登录并取得会话（kdservice-sessionid）'
        : '登录成功但未返回会话 Cookie；若后续拉取失败，检查 extraHeaders 是否需要额外鉴权头',
    };
  } catch (e: any) {
    return { ok: false, message: String(e?.message || e) };
  }
}

export async function kingdeeFetchMetadata(
  formIds: string[],
  opts: { projectId?: string; configId?: string; appSecret?: string; password?: string } = {},
  secrets?: vscode.SecretStorage,
  loadProjectConfig?: (id: string) => ProjectConfig | null,
): Promise<KingdeeFetchResult> {
  try {
    if (!opts.projectId) return { ok: false, error: '当前没有选中项目，无法读取该项目的金蝶连接配置' };
    const pc = findKingdeeConfig(loadProjectConfig?.(opts.projectId) || undefined, opts.configId);
    if (!pc?.baseUrl) {
      return { ok: false, error: '当前项目未配置金蝶连接：请在「项目配置 → 金蝶云星空」填写站点地址' };
    }
    if (!formIds.length) return { ok: false, error: '请至少填写一个表单标识（如 BD_MATERIAL）' };

    const sec = secrets ? await loadSecret(secrets, opts.projectId, opts.configId) : {};
    const cfg = buildKingdeeConfig(pc, {
      appSecret: opts.appSecret || sec.appSecret,
      password: opts.password || sec.password,
    });

    const cookie = await login(cfg);
    const chunks: string[] = [];
    for (const formId of formIds) {
      // 官方 QueryBusinessInfo 入参：{ parameters: [{ FormId }] }
      // （直接发 {FormId} 服务端会报“接口参数 data 不能为空”；parameters 内放 JSON 字符串是少数部署的兼容写法）
      const formArg = { FormId: formId };
      const body = cfg.argStyle === 'parameters'
        ? { parameters: [JSON.stringify(formArg)] }
        : { parameters: [formArg] };
      const res = await doHttpRequest({
        url: joinUrl(cfg.baseUrl, cfg.metadataPath || DEFAULT_METADATA_PATH),
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(cookie ? { Cookie: cookie } : {}),
          ...(cfg.extraHeaders || {}),
        },
        body: JSON.stringify(body),
        timeoutMs: 30000,
      } as any);
      const text = String(res.bodyText ?? '');
      // 401/403 优先给出可操作的排查指引（移到空响应判断之前，避免 403 空体被“接口无返回”吞掉）
      if (res.status === 401 || res.status === 403) {
        return {
          ok: false,
          error: `鉴权被拒（HTTP ${res.status}）：登录未拿到会话 Cookie 或会话已失效。请检查「高级参数 → 附加请求头」是否需要补充鉴权头，或确认登录接口路径 / 账号权限 / IP 白名单`,
        };
      }
      if (!text) return { ok: false, error: `接口无返回（HTTP ${res.status}）` };
      chunks.push(text);
    }
    // 多个表单时合成一个数组，webview 侧解析器能识别
    return { ok: true, text: chunks.length === 1 ? chunks[0] : JSON.stringify(chunks.map((c) => safeParse(c))) };
  } catch (e: any) {
    return { ok: false, error: String(e?.message || e) };
  }
}

function safeParseJson(s: string): Record<string, string> {
  try { return JSON.parse(s) as Record<string, string>; } catch { return {}; }
}


function safeParse(s: string): any {
  try { return JSON.parse(s); } catch { return s; }
}
