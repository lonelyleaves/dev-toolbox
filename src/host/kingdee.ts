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
const DEFAULT_METADATA_PATH = 'Kingdee.BOS.WebApi.ServicesStub.DynamicFormService.QueryBusinessInfo.common.kdsvc';

function joinUrl(base: string, path: string): string {
  return `${base.replace(/\/+$/, '')}/${path.replace(/^\/+/, '')}`;
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

export async function loadSecret(secrets: vscode.SecretStorage): Promise<{ appSecret?: string; password?: string }> {
  try {
    const raw = await secrets.get(KINGDEE_SECRET_KEY);
    return raw ? JSON.parse(raw) : {};
  } catch {
    return {};
  }
}

export async function saveSecret(secrets: vscode.SecretStorage, appSecret?: string, password?: string) {
  const cur = await loadSecret(secrets);
  await secrets.store(KINGDEE_SECRET_KEY, JSON.stringify({
    appSecret: appSecret ?? cur.appSecret ?? '',
    password: password ?? cur.password ?? '',
  }));
}

/** 登录，返回会话 Cookie（金蝶 WebAPI 用 Cookie 维持会话） */
async function login(cfg: KingdeeConfig): Promise<string> {
  const body = cfg.argStyle === 'named'
    ? { dbId: cfg.dbId, user: cfg.user, password: cfg.password, lcid: cfg.lcid ?? 2052 }
    : { parameters: [cfg.dbId, cfg.user, cfg.password, cfg.lcid ?? 2052] };
  const res = await doHttpRequest({
    url: joinUrl(cfg.baseUrl, cfg.loginPath || DEFAULT_LOGIN_PATH),
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    timeoutMs: 20000,
  } as any);
  const cookie = pickSessionCookie(res.headers?.['set-cookie'] ?? (res.headers as any)?.['Set-Cookie']);
  const text = String(res.bodyText ?? '');
  // LoginResultType: 1 表示成功（0 失败/-1 账套不存在等）
  if (text && !/LoginResultType["'\s:]+1/.test(text) && !cookie) {
    throw new Error(`登录失败：${text.slice(0, 200)}`);
  }
  return cookie;
}

/**
 * 拉取指定表单的元数据，返回原始报文文本。
 * 解析交给 webview 侧的 parseKingdeeMetadata，保持"取数"与"解析"分离（便于粘贴报文复用解析）。
 */
export async function kingdeeFetchMetadata(
  formIds: string[],
  overrides: Partial<KingdeeConfig> = {},
  secrets?: vscode.SecretStorage,
): Promise<KingdeeFetchResult> {
  try {
    const base = readCfg();
    const sec = secrets ? await loadSecret(secrets) : {};
    // 注意：overrides 里的 undefined 不能覆盖已取到的值（{...{a:1}, ...{a:undefined}} 会得到 undefined）
    const cfg: KingdeeConfig = {
      ...base,
      appSecret: overrides.appSecret || sec.appSecret || '',
      password: overrides.password || sec.password || '',
    };
    if (!cfg.baseUrl) return { ok: false, error: '未配置 devToolbox.kingdee.baseUrl' };
    if (!formIds.length) return { ok: false, error: '请至少填写一个表单标识（如 BD_MATERIAL）' };

    const cookie = await login(cfg);
    const chunks: string[] = [];
    for (const formId of formIds) {
      // 官方报文：{ "FormId": "BD_MATERIAL" }（大写 FormId）
      const body = cfg.argStyle === 'named'
        ? { FormId: formId, ...(cfg.appId ? { appId: cfg.appId } : {}), ...(cfg.appSecret ? { appSecret: cfg.appSecret } : {}) }
        : { parameters: [formId] };
      const res = await doHttpRequest({
        url: joinUrl(cfg.baseUrl, cfg.metadataPath || DEFAULT_METADATA_PATH),
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(cookie ? { Cookie: cookie } : {}),
          ...(base.extraHeaders || {}),
        },
        body: JSON.stringify(body),
        timeoutMs: 30000,
      } as any);
      const text = String(res.bodyText ?? '');
      if (!text) return { ok: false, error: `接口无返回（HTTP ${res.status}）` };
      chunks.push(text);
    }
    // 多个表单时合成一个数组，webview 侧解析器能识别
    return { ok: true, text: chunks.length === 1 ? chunks[0] : JSON.stringify(chunks.map((c) => safeParse(c))) };
  } catch (e: any) {
    return { ok: false, error: String(e?.message || e) };
  }
}

function safeParse(s: string): any {
  try { return JSON.parse(s); } catch { return s; }
}
