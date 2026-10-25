import { useState, useCallback, useEffect } from 'preact/hooks';
import { CopyBtn, Section, Btn, usePersistentState, clipPrefill } from '../components';
import {
  hexToRgb, rgbToHex, rgbToHsl, hslToRgb, parseColor, rgbToCssString,
  contrastRatio, wcagRating, RgbColor, HslColor,
  HASH_ALGORITHMS, HashAlgorithm, HashOutputFormat, computeHash,
  generateUuid, generateBulkUuids,
} from '../../logic/colorx';
import { Prefill } from '../app';

type Tab = 'color' | 'hash' | 'uuid';

export function ColorHashPage({ prefill }: { prefill?: Prefill }) {
  const [tab, setTab] = useState<Tab>('color');
  return (
    <div>
      <div class="toolbar" style="margin-bottom:12px">
        {(['color', 'hash', 'uuid'] as Tab[]).map((t) => (
          <button key={t} class={`btn${tab === t ? ' primary' : ''}`} onClick={() => setTab(t)}>
            {{ color: '颜色转换', hash: '哈希生成', uuid: 'UUID' }[t]}
          </button>
        ))}
      </div>
      {tab === 'color' && <ColorPanel prefill={prefill} />}
      {tab === 'hash' && <HashPanel />}
      {tab === 'uuid' && <UuidPanel />}
    </div>
  );
}

function ColorPanel({ prefill }: { prefill?: Prefill }) {
  const [colorInput, setColorInput] = usePersistentState('colorHash.color', '#4f8cc9');
  const [rgb, setRgb] = useState<RgbColor | null>(null);
  const [hsl, setHsl] = useState<HslColor | null>(null);
  const [error, setError] = useState('');
  const [fgColor, setFgColor] = useState('#000000');

  // prefill 变化即生效（面板停留在本工具时再次右键送入内容也能刷新）
  useEffect(() => {
    if (prefill && prefill.toolId === 'colorHash') setColorInput(clipPrefill(prefill.text.trim(), 200));
  }, [prefill]);

  useEffect(() => {
    try {
      const parsed = parseColor(colorInput);
      setRgb(parsed);
      setHsl(rgbToHsl(parsed));
      setError('');
    } catch (e: any) {
      setRgb(null);
      setHsl(null);
      setError(e?.message || String(e));
    }
  }, [colorInput]);

  const hex = rgb ? rgbToHex(rgb) : '';
  const css = rgb ? rgbToCssString(rgb) : '';
  const ratio = rgb ? contrastRatio(rgb, parseColor(fgColor)) : 0;
  const wcag = wcagRating(ratio);

  return (
    <div>
      <div class="toolbar">
        <input type="color" value={hex?.slice(0, 7) || '#000000'} onInput={(e) => setColorInput(e.currentTarget.value)} />
        <input type="text" value={colorInput} onInput={(e) => setColorInput(e.currentTarget.value)} style="width:220px" placeholder="输入颜色：#hex / rgb() / hsl()" />
        <span class="muted small">前景色：</span>
        <input type="color" value={fgColor} onInput={(e) => setFgColor(e.currentTarget.value)} />
      </div>
      {error && <div class="hint warn"><span class="error-text">{error}</span></div>}
      {rgb && (
        <>
          <div style="display:flex;gap:12px;margin:10px 0;align-items:flex-start">
            <div style={`width:80px;height:80px;border-radius:8px;background:${css};border:1px solid var(--vscode-panel-border);box-shadow:var(--shadow)`} />
            <div class="kv" style="flex:1">
              <span class="k">HEX</span><span class="v"><CopyBtn text={() => hex} /> {hex}</span>
              <span class="k">RGB</span><span class="v"><CopyBtn text={() => `rgb(${rgb.r}, ${rgb.g}, ${rgb.b})`} /> rgb({rgb.r}, {rgb.g}, {rgb.b})</span>
              <span class="k">HSL</span><span class="v"><CopyBtn text={() => `hsl(${hsl!.h}, ${hsl!.s}%, ${hsl!.l}%)`} /> hsl({hsl!.h}, {hsl!.s}%, {hsl!.l}%)</span>
              <span class="k">CSS</span><span class="v"><CopyBtn text={() => css} /> {css}</span>
            </div>
          </div>
          <Section title="WCAG 对比度">
            <div class="kv">
              <span class="k">对比度</span><span class="v">{ratio.toFixed(2)} : 1</span>
              <span class="k">AA 正文</span><span class="v"><span class={`badge ${wcag.aa ? 'ok' : 'err'}`}>{wcag.aa ? '通过' : '不通过'}</span></span>
              <span class="k">AA 大字</span><span class="v"><span class={`badge ${wcag.aaLarge ? 'ok' : 'err'}`}>{wcag.aaLarge ? '通过' : '不通过'}</span></span>
              <span class="k">AAA 正文</span><span class="v"><span class={`badge ${wcag.aaa ? 'ok' : 'err'}`}>{wcag.aaa ? '通过' : '不通过'}</span></span>
              <span class="k">AAA 大字</span><span class="v"><span class={`badge ${wcag.aaaLarge ? 'ok' : 'err'}`}>{wcag.aaaLarge ? '通过' : '不通过'}</span></span>
            </div>
          </Section>
        </>
      )}
    </div>
  );
}

function HashPanel() {
  const [input, setInput] = usePersistentState('colorHash.hashInput', '');
  const [algo, setAlgo] = useState<HashAlgorithm>('SHA-256');
  const [format, setFormat] = useState<HashOutputFormat>('hex');
  const [result, setResult] = useState('');
  const [loading, setLoading] = useState(false);

  const handleHash = useCallback(async () => {
    setLoading(true);
    try {
      const hash = await computeHash(input, algo, format);
      setResult(hash);
    } catch (e: any) {
      setResult('错误: ' + (e?.message || String(e)));
    }
    setLoading(false);
  }, [input, algo, format]);

  return (
    <div>
      <div class="toolbar">
        <select value={algo} onChange={(e) => setAlgo(e.currentTarget.value as HashAlgorithm)}>
          {HASH_ALGORITHMS.map((a) => (
            <option key={a.id} value={a.id}>{a.label} ({a.bits} bit)</option>
          ))}
        </select>
        <select value={format} onChange={(e) => setFormat(e.currentTarget.value as HashOutputFormat)}>
          <option value="hex">Hex</option>
          <option value="base64">Base64</option>
        </select>
        <Btn primary onClick={handleHash} disabled={loading}>
          {loading ? <span class="spinner" /> : null} 计算哈希
        </Btn>
      </div>
      <Section title="输入">
        <textarea class="code grow" rows={4} value={input} onInput={(e) => setInput(e.currentTarget.value)} placeholder="输入要计算哈希的文本…" />
      </Section>
      <Section title="输出">
        <div style="display:flex;gap:8px;margin-bottom:6px">
          <CopyBtn text={() => result} />
        </div>
        <pre class="out">{result || <span class="muted">点击"计算哈希"查看结果</span>}</pre>
      </Section>
    </div>
  );
}

function UuidPanel() {
  const [uuids, setUuids] = useState<string[]>([]);
  const [count, setCount] = useState(5);

  const handleGenerate = useCallback(() => {
    setUuids(generateBulkUuids(count));
  }, [count]);

  useEffect(() => { handleGenerate(); }, []);

  return (
    <div>
      <div class="toolbar">
        <label>数量：</label>
        <input type="number" min={1} max={1000} value={count} onInput={(e) => setCount(Number(e.currentTarget.value) || 1)} style="width:80px" />
        <Btn primary onClick={handleGenerate}>生成</Btn>
        <Btn onClick={() => setUuids([generateUuid()])}>生成 1 个</Btn>
        <CopyBtn text={() => uuids.join('\n')} label="复制全部" />
      </div>
      <pre class="out">{uuids.join('\n')}</pre>
    </div>
  );
}
