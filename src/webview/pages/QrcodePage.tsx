import { h } from 'preact';
import { useState, useEffect } from 'preact/hooks';
import QRCode from 'qrcode';
import jsQR from 'jsqr';
import { Btn, CopyBtn, CodeArea, Section, usePersistentState, clipPrefill } from '../components';
import { host } from '../bridge';
import { Prefill } from '../app';

export function QrcodePage({ prefill }: { prefill?: Prefill }) {
  const [text, setText] = usePersistentState('qrcode.text', 'https://example.com');
  const [size, setSize] = useState(256);
  const [ecLevel, setEcLevel] = useState<'L' | 'M' | 'Q' | 'H'>('M');
  const [dark, setDark] = useState('#000000');
  const [light, setLight] = useState('#ffffff');
  const [dataUrl, setDataUrl] = useState('');
  const [svg, setSvg] = useState('');
  const [logo, setLogo] = useState<string | null>(null);
  const [error, setError] = useState('');
  const [batchText, setBatchText] = useState('');

  useEffect(() => {
    // 二维码容量有限，统一截断策略下取更小上限（2953 字节为 QR 上限）
    if (prefill && prefill.toolId === 'qrcode') setText(clipPrefill(prefill.text, 2000));
  }, [prefill]);

  useEffect(() => {
    (async () => {
      if (!text) { setDataUrl(''); setSvg(''); return; }
      try {
        setError('');
        const opts = { width: size, margin: 2, errorCorrectionLevel: logo ? 'H' as const : ecLevel, color: { dark, light } };
        const base = await QRCode.toDataURL(text, opts);
        setDataUrl(base);
        setSvg(await QRCode.toString(text, { ...opts, type: 'svg' }));
        if (logo) {
          const final = await embedLogo(base, logo, size);
          setDataUrl(final);
        }
      } catch (e: any) {
        setError(String(e?.message || e));
      }
    })();
  }, [text, size, ecLevel, dark, light, logo]);

  async function loadImage(src: string): Promise<HTMLImageElement> {
    return new Promise((resolve, reject) => {
      const i = new Image();
      i.onload = () => resolve(i);
      i.onerror = () => reject(new Error('图片加载失败'));
      i.src = src;
    });
  }

  async function embedLogo(base: string, logoData: string, size: number): Promise<string> {
    const [qrImg, logoImg] = await Promise.all([loadImage(base), loadImage(logoData)]);
    const c = document.createElement('canvas');
    c.width = size;
    c.height = size;
    const ctx = c.getContext('2d')!;
    ctx.drawImage(qrImg, 0, 0, size, size);
    const ls = Math.floor(size * 0.22);
    const lx = (size - ls) / 2;
    ctx.fillStyle = '#fff';
    ctx.fillRect(lx - 4, lx - 4, ls + 8, ls + 8);
    ctx.drawImage(logoImg, lx, lx, ls, ls);
    return c.toDataURL('image/png');
  }

  const [batchImages, setBatchImages] = useState<{ text: string; url: string }[]>([]);

  const runBatch = async () => {
    const lines = batchText.split('\n').map((l) => l.trim()).filter(Boolean).slice(0, 50);
    try {
      const out: { text: string; url: string }[] = [];
      for (const l of lines) {
        out.push({ text: l, url: await QRCode.toDataURL(l, { width: 180, margin: 2 }) });
      }
      setBatchImages(out);
      setError('');
    } catch (e: any) {
      // 单行内容超出二维码容量时不要静默失败
      setError(`批量生成失败：${e?.message || e}`);
    }
  };

  const [decoded, setDecoded] = useState('');

  const decodeFromFile = async () => {
    const f = await host.openBinaryFile();
    if (!f) return;
    const img = new Image();
    img.onload = () => {
      const c = document.createElement('canvas');
      c.width = img.width;
      c.height = img.height;
      const ctx = c.getContext('2d')!;
      ctx.drawImage(img, 0, 0);
      const data = ctx.getImageData(0, 0, c.width, c.height);
      const r = jsQR(data.data, data.width, data.height);
      setDecoded(r ? r.data : '未识别到二维码');
    };
    img.src = `data:image/png;base64,${f.base64}`;
  };

  const savePng = async () => {
    if (!dataUrl) return;
    const b64 = dataUrl.split(',')[1];
    await host.saveBinaryFile('qrcode.png', b64);
  };
  const saveSvg = async () => {
    if (!svg) return;
    await host.saveTextFile('qrcode.svg', svg);
  };

  return (
    <div>
      <div class="grid2">
        <div>
          <CodeArea value={text} onInput={setText} minHeight={90} placeholder="文本 / URL" />
          <div class="row" style="margin-top:8px">
            <label class="small">尺寸</label>
            <input type="number" value={size} style="width:70px" onInput={(e) => setSize(Math.min(1024, Math.max(64, Number((e.target as HTMLInputElement).value) || 256)))} />
            <label class="small">容错</label>
            <select value={ecLevel} onInput={(e) => setEcLevel((e.target as HTMLSelectElement).value as any)}>
              <option value="L">L (7%)</option><option value="M">M (15%)</option>
              <option value="Q">Q (25%)</option><option value="H">H (30%)</option>
            </select>
            <label class="small">前景</label>
            <input type="color" value={dark} onInput={(e) => setDark((e.target as HTMLInputElement).value)} style="width:32px;padding:1px" />
            <label class="small">背景</label>
            <input type="color" value={light} onInput={(e) => setLight((e.target as HTMLInputElement).value)} style="width:32px;padding:1px" />
          </div>
          <div class="row" style="margin-top:8px">
            <Btn onClick={async () => {
              const f = await host.openBinaryFile();
              if (f) setLogo(`data:image/png;base64,${f.base64}`);
            }}>嵌入 Logo</Btn>
            {logo && <Btn onClick={() => setLogo(null)}>移除 Logo</Btn>}
            <span class="small muted">嵌入 Logo 时自动提升到 H 级容错</span>
          </div>
          {error && <div class="error-text" style="margin-top:6px">{error}</div>}
          <div class="row" style="margin-top:10px">
            <Btn primary onClick={savePng}>保存 PNG</Btn>
            <Btn onClick={saveSvg}>保存 SVG</Btn>
            <CopyBtn text={() => dataUrl} label="复制图片 Base64" />
          </div>
        </div>
        <div style="text-align:center">
          {dataUrl && <div class="qr-canvas-wrap"><img src={dataUrl} width={Math.min(size, 280)} height={Math.min(size, 280)} /></div>}
        </div>
      </div>

      <Section title="批量生成（每行一个内容，最多 50 个）">
        <CodeArea value={batchText} onInput={setBatchText} minHeight={80} placeholder={'https://a.com\nhttps://b.com'} />
        <div class="row" style="margin-top:6px">
          <Btn onClick={runBatch}>生成</Btn>
          {batchImages.length > 0 && (
            <Btn onClick={async () => {
              for (let i = 0; i < batchImages.length; i++) {
                await host.saveBinaryFile(`qrcode_${i + 1}.png`, batchImages[i].url.split(',')[1]);
              }
            }}>逐个保存</Btn>
          )}
        </div>
        <div class="row" style="margin-top:8px;flex-wrap:wrap">
          {batchImages.map((b) => (
            <div style="text-align:center;margin:4px">
              <img src={b.url} width={120} height={120} />
              <div class="small muted" style="max-width:120px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">{b.text}</div>
            </div>
          ))}
        </div>
      </Section>

      <Section title="解码（从图片文件识别二维码）">
        <div class="row">
          <Btn onClick={decodeFromFile}>选择图片…</Btn>
          {decoded && <span class="mono small">{decoded}</span>}
          {decoded && <CopyBtn text={() => decoded} />}
        </div>
      </Section>
    </div>
  );
}
