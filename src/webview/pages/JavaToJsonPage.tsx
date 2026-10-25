import { h } from 'preact';
import { useState, useEffect } from 'preact/hooks';
import { javaToJson } from '../../logic/javajson';
import { Btn, CopyBtn, usePersistentState, clipPrefill } from '../components';
import { Prefill } from '../app';

const SAMPLE_SRC = `public class OrderDTO {
    private Long id;
    @JsonProperty("order_no")
    private String orderNo;
    private BigDecimal amount;
    private List<OrderItemDTO> items;
    private Map<String, Object> ext;
    @JsonIgnore
    private String internalFlag;
    private LocalDateTime createTime;
    private Status status;

    public enum Status { CREATED, PAID, SHIPPED }
}

public class OrderItemDTO {
    private String skuId;
    private Integer quantity;
    private BigDecimal price;
}`;

export function JavaToJsonPage({ prefill }: { prefill?: Prefill }) {
  const [src, setSrc] = usePersistentState('javaToJson.src', SAMPLE_SRC);
  const [maxDepth, setMaxDepth] = useState(3);
  const [dateStyle, setDateStyle] = useState<'iso' | 'space' | 'timestamp'>('space');
  const [output, setOutput] = useState('');
  const [error, setError] = useState('');

  useEffect(() => {
    if (prefill && prefill.toolId === 'javaToJson') setSrc(clipPrefill(prefill.text));
  }, [prefill]);

  const run = () => {
    const r = javaToJson(src, { maxDepth, dateStyle });
    if (r.error) { setError(r.error); setOutput(''); }
    else { setError(''); setOutput(r.json); }
  };

  useEffect(() => { run(); }, [maxDepth, dateStyle]);

  return (
    <div>
      <div class="grid2">
        <div>
          <textarea class="code" style="min-height:320px" value={src} onInput={(e) => setSrc((e.target as HTMLTextAreaElement).value)} placeholder="粘贴 Java 类源码（支持嵌套类/枚举/泛型/Jackson 注解）" />
          <div class="toolbar">
            <Btn primary onClick={run}>生成 JSON</Btn>
            <label class="small">展开深度</label>
            <input type="number" min={1} max={6} value={maxDepth} style="width:56px" onInput={(e) => setMaxDepth(Number((e.target as HTMLInputElement).value) || 3)} />
            <label class="small">日期风格</label>
            <select value={dateStyle} onInput={(e) => setDateStyle((e.target as HTMLSelectElement).value as any)}>
              <option value="space">2026-01-01 12:00:00</option>
              <option value="iso">ISO8601</option>
              <option value="timestamp">时间戳</option>
            </select>
          </div>
        </div>
        <div>
          {error && <div class="error-text">✗ {error}</div>}
          {output && (
            <div>
              <pre class="out" style="max-height:360px">{output}</pre>
              <CopyBtn text={() => output} label="复制 JSON" />
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
