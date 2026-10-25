import * as http from 'http';
import * as https from 'https';
import { HttpRequestPayload, HttpResponseData } from '../core/messaging';

const TEXT_TYPES = /(json|text|xml|html|javascript|css|csv|urlencoded|yaml|x-ndjson|protobuf)/i;

/** 跟随重定向的 HTTP 客户端（Node 原生实现，无第三方依赖） */
export async function doHttpRequest(payload: HttpRequestPayload): Promise<HttpResponseData> {
  const started = Date.now();
  let url: URL;
  try {
    url = new URL(payload.url);
  } catch {
    throw new Error(`无效的 URL: ${payload.url}`);
  }
  if (!['http:', 'https:'].includes(url.protocol)) {
    throw new Error(`不支持的协议: ${url.protocol}（仅支持 http/https）`);
  }
  let redirectLeft = 5;
  const maxBytes = payload.maxBytes ?? 5 * 1024 * 1024;

  const send = (): Promise<{ res: http.IncomingMessage; body: Buffer; truncated: boolean }> =>
    new Promise((resolve, reject) => {
      const lib = url.protocol === 'https:' ? https : http;
      const req = lib.request(
        url,
        {
          method: payload.method,
          headers: payload.headers,
          timeout: payload.timeoutMs ?? 30000,
        },
        (res) => {
          const chunks: Buffer[] = [];
          let size = 0;
          let truncated = false;
          res.on('data', (c: Buffer) => {
            size += c.length;
            if (size <= maxBytes) chunks.push(c);
            else truncated = true;
          });
          res.on('end', () => resolve({ res, body: Buffer.concat(chunks), truncated }));
          res.on('error', reject);
        }
      );
      req.on('timeout', () => req.destroy(new Error('请求超时')));
      req.on('error', reject);
      if (payload.body) req.write(payload.body);
      req.end();
    });

  let { res, body, truncated } = await send();
  while (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location && redirectLeft-- > 0) {
    url = new URL(res.headers.location, url);
    ({ res, body, truncated } = await send());
  }

  const contentType = String(res.headers['content-type'] || '');
  const isText = !contentType || TEXT_TYPES.test(contentType);
  const headers: Record<string, string> = {};
  for (const [k, v] of Object.entries(res.headers)) {
    headers[k] = Array.isArray(v) ? v.join(', ') : String(v ?? '');
  }
  return {
    status: res.statusCode ?? 0,
    statusText: res.statusMessage ?? '',
    headers,
    bodyBase64: body.toString('base64'),
    bodyText: isText ? body.toString('utf8') : null,
    contentType,
    elapsedMs: Date.now() - started,
    sizeBytes: body.length,
    truncated,
  };
}
