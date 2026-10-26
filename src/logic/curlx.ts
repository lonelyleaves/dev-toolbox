import { normalizeInput } from './text';

export interface ParsedCurl {
  method: string;
  url: string;
  headers: Record<string, string>;
  body: string;
  authUser?: string;
  authPass?: string;
  insecure: boolean;
  isForm: boolean;
  errors: string[];
}

/**
 * 预处理粘贴来的 cURL 命令。
 * 常见来源：浏览器 DevTools（bash / cmd / PowerShell 三种复制格式）、文档里的折行。
 * - bash：行尾 `\` 续行
 * - PowerShell：行尾反引号续行
 * - cmd.exe：行尾 `^` 续行，且用 `^"` 转义双引号
 */
export function prepareCurlCommand(cmd: string): string {
  let s = normalizeInput(cmd).trim();
  // cmd.exe 的转义引号先还原，否则分词器会把 ^" 当成普通字符
  s = s.replace(/\^"/g, '"');
  // 三种续行符都归一化成空格
  s = s.replace(/[\\`^][ \t]*\n[ \t]*/g, ' ');
  return s;
}

/** shell 风格分词（支持单双引号、转义、续行符） */
export function tokenizeShell(cmd: string): string[] {
  const tokens: string[] = [];
  let cur = '';
  let quote: '"' | "'" | null = null;
  let has = false;
  const s = prepareCurlCommand(cmd).replace(/\\\n/g, ' ');
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (quote) {
      if (ch === '\\' && quote === '"' && i + 1 < s.length) {
        cur += s[++i];
      } else if (ch === quote) {
        quote = null;
      } else {
        cur += ch;
      }
      continue;
    }
    if (ch === '\\') {
      if (i + 1 < s.length) cur += s[++i];
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      has = true;
      continue;
    }
    if (/\s/.test(ch)) {
      if (has || cur) tokens.push(cur);
      cur = '';
      has = false;
      continue;
    }
    cur += ch;
  }
  if (has || cur) tokens.push(cur);
  return tokens;
}

const DATA_OPTS = new Set(['-d', '--data', '--data-raw', '--data-binary', '--data-urlencode', '--urlencode']);
const FORM_OPTS = new Set(['-F', '--form']);

export function parseCurl(cmd: string): ParsedCurl {
  const result: ParsedCurl = {
    method: 'GET', url: '', headers: {}, body: '', insecure: false, isForm: false, errors: [],
  };
  const tokens = tokenizeShell(cmd);
  if (tokens.length === 0 || !/curl/.test(tokens[0])) {
    result.errors.push('命令似乎不是以 curl 开头，仍尝试解析…');
  }
  let explicitMethod: string | undefined;
  const dataParts: string[] = [];
  const formParts: string[] = [];
  const urls: string[] = [];

  for (let i = tokens[0] && /curl/.test(tokens[0]) ? 1 : 0; i < tokens.length; i++) {
    const t = tokens[i];
    const next = () => tokens[++i] ?? '';
    switch (t) {
      case '-X': case '--request': explicitMethod = next().toUpperCase(); break;
      case '-H': case '--header': {
        const h = next();
        const idx = h.indexOf(':');
        if (idx > 0) result.headers[h.slice(0, idx).trim()] = h.slice(idx + 1).trim();
        else result.errors.push(`忽略非法 header: ${h}`);
        break;
      }
      case '-b': case '--cookie': result.headers['Cookie'] = next(); break;
      case '-u': case '--user': {
        const v = next();
        const idx = v.indexOf(':');
        result.authUser = idx >= 0 ? v.slice(0, idx) : v;
        result.authPass = idx >= 0 ? v.slice(idx + 1) : '';
        break;
      }
      case '-A': case '--user-agent': result.headers['User-Agent'] = next(); break;
      case '-e': case '--referer': result.headers['Referer'] = next(); break;
      case '--json': {
        // curl 7.82+ --json = -H 'Content-Type: application/json' -H 'Accept: application/json' -d <data>
        result.headers['Content-Type'] = 'application/json';
        result.headers['Accept'] = 'application/json';
        dataParts.push(next());
        break;
      }
      case '--compressed': break;
      case '-L': case '--location': break;
      case '-k': case '--insecure': result.insecure = true; break;
      case '-v': case '--verbose': case '-s': case '--silent': case '-S': case '--show-error': case '-i': case '--include': break;
      case '-o': case '--output': case '--max-time': case '-m': case '--connect-timeout': next(); break;
      case '--url': urls.push(next()); break;
      default:
        if (DATA_OPTS.has(t)) dataParts.push(next());
        else if (FORM_OPTS.has(t)) { formParts.push(next()); result.isForm = true; }
        else if (/^-/.test(t)) result.errors.push(`未识别的选项 ${t}，已忽略`);
        else if (/^https?:\/\//i.test(t)) urls.push(t);
        else if (/^\w+=/.test(t)) formParts.push(t);
        else if (!t.startsWith('-')) urls.push(t);
    }
  }

  result.url = urls[0] || '';
  if (urls.length > 1) result.errors.push(`发现多个 URL，仅使用第一个: ${urls[0]}`);
  if (formParts.length > 0) {
    result.body = formParts.join('&');
    if (!result.headers['Content-Type']) result.headers['Content-Type'] = 'application/x-www-form-urlencoded';
  } else if (dataParts.length > 0) {
    result.body = dataParts.join('&');
  }
  if (result.authUser !== undefined && !result.headers['Authorization']) {
    result.headers['Authorization'] = `Basic ${btoaUnicodesafe(`${result.authUser}:${result.authPass ?? ''}`)}`;
  }
  if (result.body && !result.headers['Content-Type'] && !result.isForm) {
    if (result.body.trim().startsWith('{') || result.body.trim().startsWith('[')) {
      result.headers['Content-Type'] = 'application/json';
    } else {
      result.headers['Content-Type'] = 'application/x-www-form-urlencoded';
    }
  }
  result.method = explicitMethod || (result.body ? 'POST' : 'GET');
  return result;
}

function btoaUnicodesafe(s: string): string {
  try {
    return btoa(s);
  } catch {
    return btoa(unescape(encodeURIComponent(s)));
  }
}

/** 导出为各语言代码 */
export function generateCode(p: ParsedCurl, lang: 'fetch' | 'axios' | 'python' | 'okhttp' | 'go'): string {
  const headers = Object.entries(p.headers);
  const bodyLit = JSON.stringify(p.body);
  switch (lang) {
    case 'fetch': {
      const opt: string[] = [`  method: ${JSON.stringify(p.method)}`];
      if (headers.length) opt.push(`  headers: ${JSON.stringify(Object.fromEntries(headers), null, 2).replace(/\n/g, '\n  ')}`);
      if (p.body) opt.push(`  body: ${bodyLit}`);
      return `const res = await fetch(${JSON.stringify(p.url)}, {\n${opt.join(',\n')}\n});\nconst data = await res.text();\nconsole.log(data);`;
    }
    case 'axios': {
      const cfg: string[] = [`    method: ${JSON.stringify(p.method.toLowerCase())},`, `    url: ${JSON.stringify(p.url)}`];
      if (headers.length) cfg.push(`    headers: ${JSON.stringify(Object.fromEntries(headers))}`);
      if (p.body) cfg.push(`    data: ${bodyLit}`);
      return `import axios from 'axios';\n\nconst { data } = await axios({\n${cfg.join(',\n')},\n  });\nconsole.log(data);`;
    }
    case 'python': {
      const lines = [`import requests`, ``, `resp = requests.${p.method.toLowerCase()}(`, `    ${JSON.stringify(p.url)},`];
      if (headers.length) lines.push(`    headers=${JSON.stringify(Object.fromEntries(headers))},`);
      if (p.body) lines.push(`    data=${bodyLit},`);
      lines.push(`)`, `print(resp.status_code)`, `print(resp.text)`);
      return lines.join('\n');
    }
    case 'okhttp': {
      const b = [`Request request = new Request.Builder()`, `    .url(${JSON.stringify(p.url)})`];
      const methodBody = p.body
        ? `RequestBody body = RequestBody.create(${bodyLit}, MediaType.parse(${JSON.stringify(p.headers['Content-Type'] || 'text/plain')}));\n`
        : '';
      if (p.method === 'GET' || p.method === 'DELETE') b.push(`    .${p.method.toLowerCase()}()`);
      else b.push(`    .${p.method.toLowerCase()}(body)`);
      for (const [k, v] of headers) if (k !== 'Content-Type') b.push(`    .addHeader(${JSON.stringify(k)}, ${JSON.stringify(v)})`);
      b.push(`    .build();`);
      return `${methodBody}${b.join('\n')}\n\ntry (Response response = new OkHttpClient().newCall(request).execute()) {\n    System.out.println(response.body().string());\n}`;
    }
    case 'go': {
      const lines = [`package main`, ``, `import (`, `	"fmt"`, `	"io"`, `	"net/http"`];
      if (p.body) lines.push(`	"strings"`);
      lines.push(`)`, ``, `func main() {`);
      lines.push(`	client := &http.Client{}`);
      if (p.body) lines.push(`	req, _ := http.NewRequest(${JSON.stringify(p.method)}, ${JSON.stringify(p.url)}, strings.NewReader(${bodyLit}))`);
      else lines.push(`	req, _ := http.NewRequest(${JSON.stringify(p.method)}, ${JSON.stringify(p.url)}, nil)`);
      for (const [k, v] of headers) lines.push(`	req.Header.Set(${JSON.stringify(k)}, ${JSON.stringify(v)})`);
      lines.push(`	resp, err := client.Do(req)`, `	if err != nil {`, `		panic(err)`, `	}`, `	defer resp.Body.Close()`, `	data, _ := io.ReadAll(resp.Body)`, `	fmt.Println(string(data))`, `}`);
      return lines.join('\n');
    }
  }
}
