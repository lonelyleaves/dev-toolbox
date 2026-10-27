import { useState, useCallback, useEffect } from 'preact/hooks';
import { CopyBtn, Section, Btn, CodeArea, usePersistentState, clipPrefill } from '../components';
import { ENCODE_MODES, EncodeMode, encode, decode, HOST_MODES, ONE_WAY_MODES, base64ToHex, fromHtmlEntities } from '../../logic/encodex';
import { Prefill } from '../app';
import { host } from '../bridge';

/** 小字段行（风格同连接配置页的 Field） */
function Field(p: { label: string; children: any; hint?: string }) {
  return (
    <label class="row" style="gap:6px; margin-bottom:6px">
      <span style="width:88px; flex:none" class="small">{p.label}</span>
      {p.children}
      {p.hint && <span class="small muted">{p.hint}</span>}
    </label>
  );
}

/** 参数状态：每个模式一份默认值，切模式时重置（避免上次的 AES 参数串到 Hash 上） */
type Params = Record<string, string | boolean>;
const DEFAULT_PARAMS: Record<string, Params> = {
  hash: { alg: 'md5', hmac: false, hmacKey: '' },
  aes: { key: '', keyEnc: 'utf8', iv: '', ivEnc: 'utf8', symMode: 'cbc', padding: 'pkcs7', outEnc: 'base64' },
  des: { key: '', keyEnc: 'utf8', iv: '', ivEnc: 'utf8', symMode: 'cbc', padding: 'pkcs7', outEnc: 'base64' },
  charset: { charset: 'gbk' },
  eas: { charset: 'gbk' },
  random: { kind: 'uuid', len: '16', min: '0', max: '100', upper: true, lower: true, digits: true, symbols: false },
};

export function EncodePage({ prefill }: { prefill?: Prefill }) {
  const [mode, setMode] = useState<EncodeMode>('base64');
  const [input, setInput] = usePersistentState('encode.input', '');
  const [output, setOutput] = useState('');
  const [error, setError] = useState('');
  const [direction, setDirection] = useState<'encode' | 'decode'>('encode');
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState('');
  const [params, setParams] = useState<Params>(DEFAULT_PARAMS.base64 ?? {});

  const isHost = HOST_MODES.has(mode);
  const oneWay = ONE_WAY_MODES.has(mode);

  // 切模式：重置参数 + 清旧结果（不同模式的参数含义完全不同）
  useEffect(() => {
    setParams(DEFAULT_PARAMS[mode] ?? {});
    setOutput('');
    setError('');
    setNote('');
  }, [mode]);

  // prefill 变化即生效（面板停留在本工具时再次右键送入内容也能刷新）
  useEffect(() => {
    if (prefill && prefill.toolId === 'encode') setInput(clipPrefill(prefill.text));
  }, [prefill]);

  const p = params;
  const set = (k: string, v: string | boolean) => setParams((prev) => ({ ...prev, [k]: v }));

  const buildHostPayload = useCallback(() => {
    switch (mode) {
      case 'hash': {
        const alg = String(p.alg || 'md5');
        return (p.hmac
          ? { op: 'hmac', algorithm: alg === 'md5' ? 'sha256' : alg, key: String(p.hmacKey || ''), input }
          : { op: 'hash', algorithm: alg, input });
      }
      case 'aes':
      case 'des':
        return {
          op: 'symmetric',
          action: direction === 'encode' ? 'encrypt' : 'decrypt',
          cipher: mode,
          key: String(p.key || ''),
          keyEnc: String(p.keyEnc || 'utf8'),
          iv: String(p.iv || ''),
          ivEnc: String(p.ivEnc || 'utf8'),
          mode: String(p.symMode || 'cbc'),
          padding: String(p.padding || 'pkcs7'),
          outEnc: String(p.outEnc || 'base64'),
          input,
        };
      case 'charset':
        return {
          op: 'charset',
          charsetAction: direction === 'encode' ? 'toBytes' : 'fromBytes',
          charset: String(p.charset || 'gbk'),
          input,
        };
      case 'random': {
        const kind = String(p.kind || 'uuid');
        const base: any = { op: 'random', randomKind: kind };
        if (kind === 'password' || kind === 'bytes') base.randomLength = Number(p.len || 16);
        if (kind === 'password') base.randomChars = { upper: p.upper, lower: p.lower, digits: p.digits, symbols: p.symbols };
        if (kind === 'int') { base.randomMin = Number(p.min || 0); base.randomMax = Number(p.max || 100); }
        return base;
      }
      default:
        throw new Error('非宿主运算模式');
    }
  }, [mode, direction, input, p]);

  const handleConvert = useCallback(async () => {
    setError('');
    if (mode === 'eas') {
      setBusy(true);
      try {
        const hex = base64ToHex(input);
        const cs = String(p.charset || 'gbk');
        let r: any = await host.cryptoOps({ op: 'charset', charsetAction: 'fromBytes', charset: cs as any, input: hex });
        let warn = '';
        if (!r.ok && cs !== 'utf8') {
          r = await host.cryptoOps({ op: 'charset', charsetAction: 'fromBytes', charset: 'utf8', input: hex });
          if (r.ok) warn = `${cs.toUpperCase()} 解码失败，已自动按 UTF-8 重试成功`;
        }
        if (!r.ok) {
          setError(r.error);
          setOutput('');
        } else {
          setOutput(fromHtmlEntities(r.text ?? ''));
          setError('');
          setNote(warn);
        }
      } catch (e: any) {
        setError(e?.message || String(e));
        setOutput('');
      } finally {
        setBusy(false);
      }
      return;
    }
    if (isHost) {
      setBusy(true);
      try {
        const r = await host.cryptoOps(buildHostPayload() as any);
        if (!r.ok) {
          setError(r.error + (r.supports ? `（当前运行时支持: ${Object.entries(r.supports).filter(([, v]) => v).map(([k]) => k).join('、') || '无'}）` : ''));
          setOutput('');
        } else {
          setOutput(r.text ?? '');
        }
      } catch (e: any) {
        setError(e?.message || String(e));
        setOutput('');
      } finally {
        setBusy(false);
      }
      return;
    }
    try {
      const result = direction === 'encode' ? encode(input, mode) : decode(input, mode);
      setOutput(result);
    } catch (e: any) {
      setError(e?.message || String(e));
      setOutput('');
    }
  }, [input, mode, direction, isHost, buildHostPayload]);

  const handleSwap = useCallback(() => {
    setInput(output);
    setOutput('');
    if (!oneWay) setDirection((d) => (d === 'encode' ? 'decode' : 'encode'));
  }, [output, oneWay]);

  const actionLabel = oneWay ? (mode === 'hash' ? '计算' : '生成') : busy ? '计算中…' : '转换';

  return (
    <div>
      <div class="toolbar">
        <select value={mode} onChange={(e) => setMode(e.currentTarget.value as EncodeMode)}>
          {ENCODE_MODES.map((m) => (
            <option key={m.id} value={m.id}>{m.label} - {m.desc}</option>
          ))}
        </select>
        {!oneWay && (
          <select value={direction} onChange={(e) => setDirection(e.currentTarget.value as 'encode' | 'decode')}>
            {(mode === 'aes' || mode === 'des'
              ? <><option value="encode">加密 →</option><option value="decode">← 解密</option></>
              : <><option value="encode">编码 →</option><option value="decode">← 解码</option></>
            )}
          </select>
        )}
        <Btn primary disabled={busy} onClick={() => void handleConvert()}>{actionLabel}</Btn>
        <Btn onClick={handleSwap} title="将输出填入输入">⇅ 交换</Btn>
        <Btn onClick={() => { setInput(''); setOutput(''); setError(''); }}>清空</Btn>
      </div>

      {isHost && <HostParams mode={mode} p={p} set={set} direction={direction} />}

      <Section title="输入">
        <CodeArea
          value={input}
          onInput={setInput}
          rows={6}
          placeholder={mode === 'jwt' ? '粘贴 JWT Token（可带 Bearer 前缀）…'
            : mode === 'charset' && direction === 'encode' ? '输入 UTF-8 文本（输出目标编码字节 Hex）…'
            : mode === 'charset' ? '粘贴目标编码字节 Hex（如 GBK: d6d0）…'
            : mode === 'eas' ? '粘贴 Base64 包裹的 EAS 报文（可带换行/包裹头）…'
            : mode === 'random' ? '随机生成无需输入（下方直接生成）'
            : '输入要转换的文本…'}
        />
      </Section>

      {error && <div class="hint warn"><span class="error-text">{error}</span></div>}
      {!error && note && <div class="hint"><span class="small muted">{note}</span></div>}

      <Section title="输出">
        <div style="display:flex;gap:8px;margin-bottom:6px">
          <CopyBtn text={() => output} />
        </div>
        <pre class="out">{output || <span class="muted">{oneWay ? '点击"计算/生成"查看结果' : '点击"转换"查看结果'}</span>}</pre>
      </Section>
    </div>
  );
}

/** 宿主运算模式的动态参数区（按模式渲染） */
function HostParams({ mode, p, set, direction }: { mode: EncodeMode; p: Params; set: (k: string, v: string | boolean) => void; direction: 'encode' | 'decode' }) {
  if (mode === 'hash') {
    return (
      <Section title="参数">
        <Field label="算法">
          <select value={String(p.alg)} onChange={(e) => set('alg', e.currentTarget.value)}>
            <option value="md5">MD5</option>
            <option value="sha1">SHA-1</option>
            <option value="sha256">SHA-256</option>
            <option value="sha384">SHA-384</option>
            <option value="sha512">SHA-512</option>
          </select>
        </Field>
        <Field label="HMAC 签名">
          <input type="checkbox" checked={Boolean(p.hmac)} onChange={(e) => set('hmac', e.currentTarget.checked)} /> 带密钥（HMAC）
        </Field>
        {p.hmac && (
          <Field label="HMAC 密钥" hint="按文本提供">
            <input value={String(p.hmacKey || '')} onInput={(e: any) => set('hmacKey', e.target.value)} placeholder="密钥" style={{ width: 220 }} />
          </Field>
        )}
      </Section>
    );
  }

  if (mode === 'aes' || mode === 'des') {
    const isEcb = p.symMode === 'ecb';
    const isStream = p.symMode === 'cfb' || p.symMode === 'ctr' || p.symMode === 'ofb';
    const keyHint = mode === 'des' ? 'DES 8 字节 / 3DES 16 或 24 字节' : 'AES 须为 16/24/32 字节';
    return (
      <Section title={`参数（${direction === 'encode' ? '加密' : '解密'}）`}>
        <Field label="密钥 Key" hint={keyHint}>
          <input value={String(p.key || '')} onInput={(e: any) => set('key', e.target.value)} placeholder="密钥" style={{ width: 240 }} />
        </Field>
        <Field label="密钥编码">
          <select value={String(p.keyEnc)} onChange={(e) => set('keyEnc', e.currentTarget.value)}>
            <option value="utf8">文本（UTF-8）</option>
            <option value="base64">Base64</option>
            <option value="hex">Hex</option>
          </select>
        </Field>
        {!isEcb && (
          <>
            <Field label="IV" hint="留空按全零 IV">
              <input value={String(p.iv || '')} onInput={(e: any) => set('iv', e.target.value)} placeholder="初始向量" style={{ width: 240 }} />
            </Field>
            <Field label="IV 编码">
              <select value={String(p.ivEnc)} onChange={(e) => set('ivEnc', e.currentTarget.value)}>
                <option value="utf8">文本（UTF-8）</option>
                <option value="base64">Base64</option>
                <option value="hex">Hex</option>
              </select>
            </Field>
          </>
        )}
        <Field label="模式 Mode">
          <select value={String(p.symMode)} onChange={(e) => set('symMode', e.currentTarget.value)}>
            <option value="cbc">CBC</option>
            <option value="ecb">ECB</option>
            <option value="cfb">CFB</option>
            <option value="ctr">CTR</option>
            <option value="ofb">OFB</option>
          </select>
        </Field>
        {!isStream && (
          <Field label="填充 Padding" hint="流模式（CFB/CTR/OFB）无填充">
            <select value={String(p.padding)} onChange={(e) => set('padding', e.currentTarget.value)}>
              <option value="pkcs7">Pkcs7</option>
              <option value="zero">Zero</option>
              <option value="iso97971">Iso97971</option>
              <option value="anix923">AnsiX923</option>
              <option value="iso10126">Iso10126</option>
              <option value="none">NoPadding</option>
            </select>
          </Field>
        )}
        <Field label="输出编码">
          <select value={String(p.outEnc)} onChange={(e) => set('outEnc', e.currentTarget.value)}>
            <option value="base64">Base64</option>
            <option value="hex">HEX</option>
          </select>
        </Field>
      </Section>
    );
  }

  if (mode === 'charset') {
    return (
      <Section title="参数">
        <Field label={direction === 'encode' ? '目标编码' : '来源编码'} hint={direction === 'encode' ? '文本 → 该编码字节 Hex' : '该编码字节 Hex → 文本'}>
          <select value={String(p.charset)} onChange={(e) => set('charset', e.currentTarget.value)}>
            <option value="gbk">GBK</option>
            <option value="gb18030">GB18030</option>
            <option value="big5">Big5</option>
            <option value="utf8">UTF-8</option>
          </select>
        </Field>
      </Section>
    );
  }

  if (mode === 'eas') {
    return (
      <Section title="参数">
        <Field label="来源编码" hint="报文内字节的字符集（解码失败自动按 UTF-8 重试）">
          <select value={String(p.charset)} onChange={(e) => set('charset', e.currentTarget.value)}>
            <option value="gbk">GBK</option>
            <option value="utf8">UTF-8</option>
            <option value="big5">Big5</option>
          </select>
        </Field>
      </Section>
    );
  }

  if (mode === 'random') {
    const kind = String(p.kind);
    return (
      <Section title="参数">
        <Field label="类型">
          <select value={kind} onChange={(e) => set('kind', e.currentTarget.value)}>
            <option value="uuid">UUID v4</option>
            <option value="password">随机密码</option>
            <option value="int">随机数</option>
            <option value="bytes">随机字节（Base64）</option>
          </select>
        </Field>
        {(kind === 'password' || kind === 'bytes') && (
          <Field label="长度" hint="密码 4~128 / 字节 1~1MB">
            <input value={String(p.len)} onInput={(e: any) => set('len', e.target.value)} style={{ width: 80 }} />
          </Field>
        )}
        {kind === 'password' && (
          <Field label="字符集">
            <span class="row" style="gap:10px">
              <label class="small"><input type="checkbox" checked={Boolean(p.upper)} onChange={(e) => set('upper', e.currentTarget.checked)} /> 大写</label>
              <label class="small"><input type="checkbox" checked={Boolean(p.lower)} onChange={(e) => set('lower', e.currentTarget.checked)} /> 小写</label>
              <label class="small"><input type="checkbox" checked={Boolean(p.digits)} onChange={(e) => set('digits', e.currentTarget.checked)} /> 数字</label>
              <label class="small"><input type="checkbox" checked={Boolean(p.symbols)} onChange={(e) => set('symbols', e.currentTarget.checked)} /> 符号</label>
            </span>
          </Field>
        )}
        {kind === 'int' && (
          <Field label="区间">
            <span class="row" style="gap:6px">
              <input value={String(p.min)} onInput={(e: any) => set('min', e.target.value)} placeholder="最小值" style={{ width: 100 }} />
              <span class="muted">~</span>
              <input value={String(p.max)} onInput={(e: any) => set('max', e.target.value)} placeholder="最大值" style={{ width: 100 }} />
            </span>
          </Field>
        )}
      </Section>
    );
  }

  return null;
}
