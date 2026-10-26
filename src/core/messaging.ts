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
  event: 'openTool' | 'prefill' | 'ready';
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
  /** 本项目的连接配置摘要（用于项目栏的状态点：配没配数据库连接/金蝶连接） */
  configSummary?: { db: boolean; kingdee: boolean };
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

export interface ProjectConfig {
  connections: {
    db?: DbConnectionConfig;
    kingdee?: KingdeeConnectionConfig;
  };
}

export function emptyProjectConfig(): ProjectConfig {
  return { connections: {} };
}

export type HostCommand =
  | 'getSettings'
  | 'setPanelTitle'
  | 'copyText'
  | 'httpRequest'
  | 'saveTextFile'
  | 'saveBinaryFile'
  | 'openTextFile'
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
  | 'readState';

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
