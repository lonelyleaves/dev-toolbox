import { h } from 'preact';
import { useState, useEffect, useMemo } from 'preact/hooks';
import { parseCurl, generateCode, ParsedCurl } from '../../logic/curlx';
import { Btn, CopyBtn, CodeArea, Section, useHistory, usePersistentState, clipPrefill } from '../components';
import { host } from '../bridge';
import { Prefill } from '../app';
import { HttpResponseData } from '../../core/messaging';

export function CurlPage({ prefill }: { prefill?: Prefill }) {
  const [command, setCommand] = usePersistentState('curl.command', 'curl -X POST https://httpbin.org/post -H "Content-Type: application/json" -d \'{"name":"dev-toolbox"}\'');
  const [parsed, setParsed] = useState<ParsedCurl | null>(null);
  const [response, setResponse] = useState<HttpResponseData | null>(null);
  const [sending, setSending] = useState(false);
  const [sendError, setSendError] = useState('');
  const [genLang, setGenLang] = useState<'fetch' | 'axios' | 'python' | 'okhttp' | 'go'>('fetch');
  const [bodyView, setBodyView] = useState<'raw' | 'json'>('raw');
  const history = useHistory('curl');
  const [settings, setSettings] = useState<any>({});

  useEffect(() => {
    host.getSettings().then(setSettings).catch(() => undefined);
    if (prefill && prefill.toolId === 'curl') setCommand(clipPrefill(prefill.text.trim()));
  }, [prefill]);

  useEffect(() => {
    if (command.trim()) setParsed(parseCurl(command));
    else setParsed(null);
  }, [command]);

  const send = async () => {
    if (!parsed?.url) return;
    setSending(true);
    setSendError('');
    setResponse(null);
    history.push(command);
    try {
      const r = await host.httpRequest({
        method: parsed.method,
        url: parsed.url,
        headers: parsed.headers,
        body: parsed.body || undefined,
        timeoutMs: settings.curl?.timeoutMs ?? 30000,
        maxBytes: settings.curl?.maxResponseSize ?? 5 * 1024 * 1024,
      });
      setResponse(r);
      if (r.bodyText) {
        try { JSON.parse(r.bodyText); setBodyView('json'); } catch { setBodyView('raw'); }
      }
    } catch (e: any) {
      setSendError(String(e?.message || e));
    } finally {
      setSending(false);
    }
  };

  const prettyBody = useMemo(() => {
    if (!response?.bodyText) return '';
    if (bodyView === 'json') {
      try { return JSON.stringify(JSON.parse(response.bodyText), null, 2); } catch { return response.bodyText; }
    }
    return response.bodyText;
  }, [response, bodyView]);

  const statusCls = response ? (response.status < 400 ? 'ok' : 'err') : '';

  return (
    <div>
      <CodeArea value={command} onInput={setCommand} minHeight={110} placeholder="粘贴 curl 命令（支持多行、\ 或 ` 或 ^ 续行）" />
      <div class="toolbar">
        <Btn primary onClick={send} disabled={sending || !parsed?.url}>{sending ? '发送中…' : '发送请求'}</Btn>
        {history.items.length > 0 && (
          <select onChange={(e) => setCommand(history.items[Number((e.target as HTMLSelectElement).value)])} value="">
            <option value="" disabled>历史请求…</option>
            {history.items.map((hst, i) => <option value={i}>{hst.slice(0, 60)}</option>)}
          </select>
        )}
        {parsed?.errors.map((er) => <span class="badge warn" title={er}>{er.slice(0, 30)}</span>)}
      </div>

      {parsed && (
        <Section title="解析结果">
          <div class="row" style="margin-bottom:6px">
            <select value={parsed.method} onChange={(e) => setParsed({ ...parsed, method: (e.target as HTMLSelectElement).value })}>
              {['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD'].map((m) => <option>{m}</option>)}
            </select>
            <input type="text" class="mono grow" value={parsed.url} onInput={(e) => setParsed({ ...parsed, url: (e.target as HTMLInputElement).value })} placeholder="URL" />
          </div>
          {Object.entries(parsed.headers).map(([k, v]) => (
            <div class="row small" style="margin-bottom:3px">
              <input type="text" class="mono" style="width:180px" value={k} onInput={(e) => {
                const next = { ...parsed.headers, [(e.target as HTMLInputElement).value]: v };
                if ((e.target as HTMLInputElement).value !== k) delete next[k];
                setParsed({ ...parsed, headers: next });
              }} />
              <input type="text" class="mono grow" value={v} onInput={(e) => setParsed({ ...parsed, headers: { ...parsed.headers, [k]: (e.target as HTMLInputElement).value } })} />
              <Btn onClick={() => { const nh = { ...parsed.headers }; delete nh[k]; setParsed({ ...parsed, headers: nh }); }}>×</Btn>
            </div>
          ))}
          <Btn onClick={() => setParsed({ ...parsed, headers: { ...parsed.headers, '': '' } })}>+ Header</Btn>
          <div class="small muted" style="margin-top:6px">Body</div>
          <CodeArea value={parsed.body} onInput={(v) => setParsed({ ...parsed, body: v })} minHeight={60} />
        </Section>
      )}

      {sendError && <div class="error-text" style="margin:8px 0">✗ {sendError}</div>}

      {response && (
        <Section title="响应">
          <div class="row small" style="margin-bottom:6px">
            <span class={`badge ${statusCls}`}>{response.status} {response.statusText}</span>
            <span class="badge">{response.elapsedMs} ms</span>
            <span class="badge">{(response.sizeBytes / 1024).toFixed(1)} KB</span>
            <span class="badge">{response.contentType || '-'}</span>
            {response.truncated && <span class="badge warn">已截断</span>}
          </div>
          <details>
            <summary class="small">响应头</summary>
            <pre class="out">{Object.entries(response.headers).map(([k, v]) => `${k}: ${v}`).join('\n')}</pre>
          </details>
          <div class="toolbar">
            <button class={`btn${bodyView === 'raw' ? ' primary' : ''}`} onClick={() => setBodyView('raw')}>原文</button>
            <button class={`btn${bodyView === 'json' ? ' primary' : ''}`} onClick={() => setBodyView('json')}>JSON 树/格式化</button>
            <CopyBtn text={() => prettyBody} label="复制 Body" />
            {!response.bodyText && (
              <Btn onClick={async () => {
                const ext = /png/.test(response.contentType) ? 'png' : /json/.test(response.contentType) ? 'json' : 'bin';
                await host.saveBinaryFile(`response.${ext}`, response.bodyBase64);
              }}>保存二进制响应</Btn>
            )}
          </div>
          <pre class="out" style="max-height:360px">{prettyBody || '（二进制内容）'}</pre>
        </Section>
      )}

      {parsed && (
        <Section title="导出代码">
          <div class="toolbar">
            <select value={genLang} onInput={(e) => setGenLang((e.target as HTMLSelectElement).value as any)}>
              <option value="fetch">Fetch</option><option value="axios">Axios</option>
              <option value="python">Python requests</option><option value="okhttp">Java OkHttp</option><option value="go">Go net/http</option>
            </select>
          </div>
          <pre class="out">{generateCode(parsed, genLang)}</pre>
          <CopyBtn text={() => generateCode(parsed, genLang)} label="复制代码" />
        </Section>
      )}
    </div>
  );
}
