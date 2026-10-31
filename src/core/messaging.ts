/** host <-> webview 消息协议（两端共用） */

export interface WvRequest {
  kind: 'request';
  id: number;
  cmd: HostCommand;
  payload?: unknown;
}

export interface WvResponse {
  kind: 'response';
  id: number;
  ok: boolean;
  data?: unknown;
  error?: string;
}

/** 宿主主动推送（初始化工具、注入选区内容等） */
export interface WvPush {
  kind: 'push';
  event: 'openTool' | 'prefill' | 'ready' | 'dbProgress';
  toolId: string;
  payload?: unknown;
}

/** 项目元信息（项目库索引条目；webview 与 host 共用，故放在不依赖 vscode 的 core 里） */
export interface ProjectMeta {
  id: string;
  name: string;
  createdAt: string;
  updatedAt: string;
  sourceCount: number;
  tableCount: number;
  /** 本项目的连接配置摘要（配了几条数据库/金蝶连接，用于项目栏状态点） */
  configSummary?: { db: number; kingdee: number };
}

/** 项目级连接配置：跟着项目走，切换项目 = 切换这套连接；凭据一律不落在这里 */
export interface DbConnectionConfig {
  client?: 'mysql' | 'postgres' | 'mssql' | 'oracle';
  host?: string;
  port?: number;
  user?: string;
  /** mysql/mssql: 数据库名；postgres: database；oracle: 服务名 */
  database?: string;
}

export interface KingdeeConnectionConfig {
  baseUrl?: string;
  dbId?: string;
  appId?: string;
  user?: string;
  lcid?: number;
  loginPath?: string;
  metadataPath?: string;
  argStyle?: 'parameters' | 'named';
  extraHeaders?: string;
}

/** 宿主侧密码学/字符编码运算（cryptoOps 命令）：出入参全部 JSON 可序列化 */
export type ByteEnc = 'utf8' | 'base64' | 'hex';
export type SymCipher = 'aes' | 'des' | '3des';
export type SymMode = 'ecb' | 'cbc' | 'cfb' | 'ctr' | 'ofb';
export type SymPad = 'pkcs7' | 'zero' | 'iso97971' | 'anix923' | 'iso10126' | 'none';
export type CharsetName = 'utf8' | 'gbk' | 'gb18030' | 'big5';

export interface CryptoOpsPayload {
  op: 'hash' | 'hmac' | 'symmetric' | 'charset' | 'charsetProbe' | 'random';
  // hash / hmac
  algorithm?: string;
  input?: string;
  key?: string;
  keyEnc?: ByteEnc;
  // symmetric
  action?: 'encrypt' | 'decrypt';
  cipher?: SymCipher;
  mode?: SymMode;
  padding?: SymPad;
  iv?: string;
  ivEnc?: ByteEnc;
  /** 密文的进/出格式 */
  outEnc?: ByteEnc;
  // charset
  charsetAction?: 'toBytes' | 'fromBytes';
  charset?: CharsetName;
  // random
  randomKind?: 'uuid' | 'password' | 'int' | 'bytes';
  randomLength?: number;
  randomChars?: { upper?: boolean; lower?: boolean; digits?: boolean; symbols?: boolean };
  randomMin?: number;
  randomMax?: number;
}

export type CryptoOpsResult =
  | ({ ok: true; text?: string; supports?: Record<string, boolean> } & Record<string, unknown>)
  | { ok: false; error: string; supports?: Record<string, boolean> };

export interface NamedDbConfig extends DbConnectionConfig {
  id: string;
  name: string;
  /** 名称是否由主机自动生成（用户在连接配置里重命名后为 false） */
  autoName?: boolean;
}

export interface NamedKingdeeConfig extends KingdeeConnectionConfig {
  id: string;
  name: string;
}

/** 迁移旧单配置时赋的保留 id：凭据 key 沿用旧格式，不丢已存密码 */
export const DEFAULT_CONFIG_ID = 'default';

/** 生成新配置 id */
export function newConfigId(): string {
  return `c_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
}

/** 旧单对象 / 新数组 → 命名配置数组（无损迁移；旧单配置赋 id='default'） */
function toNamedList<T extends object>(raw: unknown, defName: string): (T & { id: string; name: string })[] {
  if (!raw) return [];
  if (Array.isArray(raw)) {
    return raw.map((x, i) => ({ ...(x as object), id: (x as any)?.id || DEFAULT_CONFIG_ID, name: (x as any)?.name || `${defName} ${i + 1}` }) as T & { id: string; name: string });
  }
  const obj = raw as object;
  return Object.keys(obj).length ? [{ ...obj, id: DEFAULT_CONFIG_ID, name: defName } as T & { id: string; name: string }] : [];
}

/** 旧配置没有 autoName：按名称形态推断是否自动命名（避免覆盖用户自定义名） */
function inferDbAutoName(c: any): boolean {
  const n = String(c?.name || '').trim();
  if (!n) return true;
  if (n === '默认数据库' || /^数据库\s*\d+$/.test(n)) return true;
  if (n === '127.0.0.1') return true;
  const host = String(c?.host || '').trim();
  const db = String(c?.database || '').trim();
  return !!host && (n === host || n === `${host}/${db}`);
}

/** 数据库配置的自动名称：优先主机，其次库名 */
function autoDbName(c: any): string {
  return String(c?.host || '').trim() || String(c?.database || '').trim();
}

/** 把任意形态（旧单对象/新数组）的连接配置归一化为数组结构 */
export function normalizeConnections(cfg: any): ProjectConfig {
  const dbs = toNamedList<DbConnectionConfig>(cfg?.connections?.db, '默认数据库').map((c) => {
    const autoName = (c as any).autoName ?? inferDbAutoName(c);
    const auto = autoName ? autoDbName(c) : '';
    return { ...c, autoName, name: auto || c.name } as NamedDbConfig;
  });
  return {
    connections: {
      db: dbs,
      kingdee: toNamedList<KingdeeConnectionConfig>(cfg?.connections?.kingdee, '默认金蝶'),
    },
  };
}

/** 按 id 取数据库配置；id 缺省取列表首个 */
export function findDbConfig(cfg: ProjectConfig | undefined, id?: string): NamedDbConfig | undefined {
  const list = cfg?.connections?.db || [];
  return id ? list.find((c) => c.id === id) || list[0] : list[0];
}

/** 按 id 取金蝶配置；id 缺省取列表首个 */
export function findKingdeeConfig(cfg: ProjectConfig | undefined, id?: string): NamedKingdeeConfig | undefined {
  const list = cfg?.connections?.kingdee || [];
  return id ? list.find((c) => c.id === id) || list[0] : list[0];
}

export interface ProjectConfig {
  connections: {
    db?: NamedDbConfig[];
    kingdee?: NamedKingdeeConfig[];
  };
}

export function emptyProjectConfig(): ProjectConfig {
  return { connections: { db: [], kingdee: [] } };
}

export type HostCommand =
  | 'getSettings'
  | 'setPanelTitle'
  | 'copyText'
  | 'httpRequest'
  | 'saveTextFile'
  | 'saveBinaryFile'
  | 'openTextFile'
  | 'openTextFiles'
  | 'readTextFileAt'
  | 'projectList'
  | 'projectCreate'
  | 'projectSwitch'
  | 'projectRename'
  | 'projectDelete'
  | 'projectClear'
  | 'projectLoad'
  | 'projectSave'
  | 'projectExport'
  | 'projectImport'
  | 'projectGetConfig'
  | 'projectSaveConfig'
  | 'projectSync'
  | 'projectDiff'
  | 'projectSaveCache'
  | 'projectCacheMeta'
  | 'kingdeeTestConfig'
  | 'projectSaveSecret'
  | 'projectReadSecretExists'
  | 'kingdeeFetchMetadata'
  | 'kingdeeSaveSecret'
  | 'openBinaryFile'
  | 'dbTestConnection'
  | 'dbIntrospect'
  | 'dbSavePassword'
  | 'getClipboard'
  | 'showMessage'
  | 'persistState'
  | 'readState'
  | 'cryptoOps';

export interface HttpRequestPayload {
  method: string;
  url: string;
  headers: Record<string, string>;
  body?: string;
  timeoutMs?: number;
  maxBytes?: number;
}

export interface HttpResponseData {
  status: number;
  statusText: string;
  headers: Record<string, string>;
  bodyBase64: string;
  bodyText: string | null; // 文本类型时给出，二进制为 null
  contentType: string;
  elapsedMs: number;
  sizeBytes: number;
  truncated: boolean;
}

export interface NamingSettings {
  tablePrefix?: string;
  requireComment?: boolean;
  requirePrimaryKey?: boolean;
  forbiddenTypes?: string[];
}

export interface SqlFormatSettings {
  dialect?: string;
  keywordCase?: 'upper' | 'lower' | 'preserve';
}

export interface CurlSettings {
  timeoutMs?: number;
  maxResponseSize?: number;
}

export interface AppSettings {
  curl: CurlSettings;
  sqlFormat: SqlFormatSettings;
  historySize: number;
  naming: NamingSettings;
}

export interface DbConnInfo {
  client: 'mysql' | 'postgres' | 'mssql' | 'oracle';
  host: string;
  port: number;
  user: string;
  /** 为空字符串时表示从 SecretStorage 读取已保存密码 */
  password: string;
  /** mysql/mssql: 数据库名；postgres: database；oracle: 服务名(Service Name) */
  database: string;
  secretKey?: string;
  /** 所属项目：有值时密码从该项目的凭据里读（Credential 按项目隔离） */
  projectId?: string;
  /** 多连接配置：定位是项目里的哪一条（缺省取列表首个） */
  configId?: string;
}

export type WebviewMsg = WvRequest | WvResponse | WvPush;

let seq = 1;

/** Webview 侧：向宿主发起 RPC 调用 */
export function hostCall<T = unknown>(
  post: (msg: WebviewMsg) => void,
  pending: Map<number, (r: WvResponse) => void>,
  cmd: HostCommand,
  payload?: unknown,
  timeoutMs = 120000
): Promise<T> {
  const id = seq++;
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`宿主调用 ${cmd} 超时`));
    }, timeoutMs);
    pending.set(id, (resp) => {
      clearTimeout(timer);
      if (resp.ok) resolve(resp.data as T);
      else reject(new Error(resp.error || `宿主调用 ${cmd} 失败`));
    });
    post({ kind: 'request', id, cmd, payload });
  });
}

export function isWebviewMsg(m: unknown): m is WebviewMsg {
  return !!m && typeof m === 'object' && 'kind' in (m as object);
}
