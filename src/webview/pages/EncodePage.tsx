import { useState, useCallback, useEffect } from 'preact/hooks';
import { CopyBtn, Section, Btn, CodeArea, usePersistentState, clipPrefill } from '../components';
import { ENCODE_MODES, EncodeMode, encode, decode } from '../../logic/encodex';
import { Prefill } from '../app';

export function EncodePage({ prefill }: { prefill?: Prefill }) {
  const [mode, setMode] = useState<EncodeMode>('base64');
  const [input, setInput] = usePersistentState('encode.input', '');
  const [output, setOutput] = useState('');
  const [error, setError] = useState('');
  const [direction, setDirection] = useState<'encode' | 'decode'>('encode');

  // prefill 变化即生效（面板停留在本工具时再次右键送入内容也能刷新）
  useEffect(() => {
    if (prefill && prefill.toolId === 'encode') setInput(clipPrefill(prefill.text));
  }, [prefill]);

  const handleConvert = useCallback(() => {
    setError('');
    try {
      const result = direction === 'encode' ? encode(input, mode) : decode(input, mode);
      setOutput(result);
    } catch (e: any) {
      setError(e?.message || String(e));
      setOutput('');
    }
  }, [input, mode, direction]);

  const handleSwap = useCallback(() => {
    setInput(output);
    setOutput('');
    setDirection((d) => (d === 'encode' ? 'decode' : 'encode'));
  }, [output]);

  return (
    <div>
      <div class="toolbar">
        <select value={mode} onChange={(e) => setMode(e.currentTarget.value as EncodeMode)}>
          {ENCODE_MODES.map((m) => (
            <option key={m.id} value={m.id}>{m.label} - {m.desc}</option>
          ))}
        </select>
        <select value={direction} onChange={(e) => setDirection(e.currentTarget.value as 'encode' | 'decode')}>
          <option value="encode">编码 →</option>
          <option value="decode">← 解码</option>
        </select>
        <Btn primary onClick={handleConvert}>转换</Btn>
        <Btn onClick={handleSwap} title="将输出填入输入">⇅ 交换</Btn>
        <Btn onClick={() => { setInput(''); setOutput(''); setError(''); }}>清空</Btn>
      </div>

      <Section title="输入">
        <CodeArea
          value={input}
          onInput={setInput}
          rows={6}
          placeholder={mode === 'jwt' ? '粘贴 JWT Token（可带 Bearer 前缀）…' : '输入要转换的文本…'}
        />
      </Section>

      {error && <div class="hint warn"><span class="error-text">{error}</span></div>}

      <Section title="输出">
        <div style="display:flex;gap:8px;margin-bottom:6px">
          <CopyBtn text={() => output} />
        </div>
        <pre class="out">{output || <span class="muted">点击"转换"查看结果</span>}</pre>
      </Section>
    </div>
  );
}
