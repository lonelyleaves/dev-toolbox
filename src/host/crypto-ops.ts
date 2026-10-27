/**
 * 宿主侧密码学/字符编码运算（node:crypto + Node 内置 ICU 的 TextDecoder/TextEncoder）。
 *
 * 为什么放宿主不放 webview：
 * - MD5/DES 浏览器 WebCrypto 没有；GBK/GB18030/Big5 浏览器根本没有。
 * - 统一走宿主，webview 只做 UI 与纯文本逻辑（全半角/码点/摩斯），
 *   与 httpRequest/dbIntrospect 同一套"取数走宿主"架构。
 *
 * 所有出入参 JSON 可序列化：二进制一律 Hex 或 Base64 文本表达。
 */
import * as crypto from 'crypto';
import * as util from 'util';
import { ByteEnc, SymCipher, SymMode, SymPad, CharsetName, CryptoOpsPayload, CryptoOpsResult } from '../core/messaging';

export type { CryptoOpsPayload, CryptoOpsResult };

function hexToBytes(s: string): Uint8Array {
  let c = String(s || '').replace(/0x/g, '').replace(/[^0-9a-fA-F]/g, '');
  if (c.length % 2 !== 0) c = c + '0';
  const out = new Uint8Array(c.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(c.slice(i * 2, i * 2 + 2), 16);
  return out;
}

function bytesToHex(b: Uint8Array): string {
  return Array.from(b).map((x) => x.toString(16).padStart(2, '0')).join('');
}

function toBytes(input: string, enc: ByteEnc): Uint8Array {
  switch (enc) {
    case 'base64': return Uint8Array.from(Buffer.from(input, 'base64'));
    case 'hex': return hexToBytes(input);
    default: return Uint8Array.from(Buffer.from(input ?? '', 'utf8'));
  }
}

function bytesToText(b: Uint8Array, enc: ByteEnc): string {
  switch (enc) {
    case 'base64': return Buffer.from(b).toString('base64');
    case 'hex': return bytesToHex(b);
    default: return Buffer.from(b).toString('utf8');
  }
}

// ─── 哈希 / HMAC ───────────────────────────────────────
const HASH_ALGS = new Set(['md5', 'sha1', 'sha256', 'sha384', 'sha512']);
const HMAC_ALGS = new Set(['sha1', 'sha256', 'sha384', 'sha512']);

function doHash(p: CryptoOpsPayload): CryptoOpsResult {
  const alg = (p.algorithm || 'md5').toLowerCase();
  if (!HASH_ALGS.has(alg)) return { ok: false, error: `不支持的哈希算法: ${p.algorithm}（可选 ${[...HASH_ALGS].join(' / ')}）` };
  return { ok: true, text: crypto.createHash(alg).update(p.input ?? '', 'utf8').digest('hex') };
}

function doHmac(p: CryptoOpsPayload): CryptoOpsResult {
  const alg = (p.algorithm || 'sha256').toLowerCase();
  if (!HMAC_ALGS.has(alg)) return { ok: false, error: `HMAC 不支持算法: ${p.algorithm}（可选 ${[...HMAC_ALGS].join(' / ')}）` };
  return { ok: true, text: crypto.createHmac(alg, p.key || '').update(p.input ?? '', 'utf8').digest('hex') };
}

// ─── 对称加解密（AES / DES / 3DES）─────────────────────
/**
 * 填充实现说明：
 * - pkcs7：块模式交给 crypto 自动（setAutoPadding(true)）
 * - zero / iso97971(方法2) / anix923：都是"补 0x00 到块边界"，手动实现
 * - iso10126：随机字节 + 末尾 1 字节长度，手动实现
 * - none：不补，要求数据长度是块倍数（流模式 cfb/ctr/ofb 天然无块约束）
 * 明文始终按 UTF-8 文本理解；密文按 outEnc（base64/hex/utf8裸文本）进出。
 */
function manualPad(data: Uint8Array, block: number, pad: SymPad): Uint8Array {
  const rem = data.length % block;
  const extra = rem === 0 ? 0 : block - rem;
  if (pad === 'iso10126') {
    const need = extra === 0 ? block : extra;
    const p = new Uint8Array(data.length + need);
    p.set(data);
    p.set(crypto.randomBytes(need - 1), data.length);
    p[data.length + need - 1] = need;
    return p;
  }
  const p = new Uint8Array(data.length + extra); // 剩余 0x00 即 zero/iso97971/anix923
  p.set(data);
  return p;
}

function manualUnpad(data: Uint8Array, block: number, pad: SymPad): Uint8Array {
  if (pad === 'iso10126') {
    const n = data.length;
    if (n === 0 || n % block !== 0) return data;
    const len = data[n - 1];
    if (len === 0 || len > block) return data;
    return data.slice(0, n - len);
  }
  let i = data.length; // zero 系：剥尾部连续 0
  while (i > 0 && data[i - 1] === 0) i--;
  return data.slice(0, i);
}

function doSymmetric(p: CryptoOpsPayload): CryptoOpsResult {
  const action = p.action === 'decrypt' ? 'decrypt' : 'encrypt';
  const cipher = p.cipher || 'aes';
  const mode = (p.mode || 'cbc') as SymMode;
  const pad = (p.padding || 'pkcs7') as SymPad;
  const outEnc = (p.outEnc || 'base64') as ByteEnc;

  let keyBytes = toBytes(p.key || '', p.keyEnc || 'utf8');
  if (!keyBytes.length) return { ok: false, error: '密钥为空' };
  let cipherName: string;
  if (cipher === 'aes') {
    if (![16, 24, 32].includes(keyBytes.length)) {
      return { ok: false, error: `AES 密钥长度须为 16/24/32 字节（当前 ${keyBytes.length}，检查密钥值或密钥编码方式）` };
    }
    cipherName = `aes-${keyBytes.length * 8}`;
  } else if (cipher === 'des') {
    if (keyBytes.length !== 8) return { ok: false, error: `DES 密钥须为 8 字节（当前 ${keyBytes.length}，检查密钥值或密钥编码方式）` };
    // OpenSSL 3 封锁单 DES，改用三 DES 退式：EDE(K,K,K,M) 数学上恒等于 E(K,M)，
    // 密文与老 OpenSSL 的单 DES 完全一致，但算法走 des-ede3 通道
    cipherName = 'des-ede3';
    keyBytes = Buffer.concat([keyBytes, keyBytes, keyBytes]);
  } else {
    if (![16, 24].includes(keyBytes.length)) return { ok: false, error: `3DES 密钥须为 16 或 24 字节（当前 ${keyBytes.length}）` };
    if (keyBytes.length === 16) keyBytes = Buffer.concat([keyBytes, keyBytes.subarray(0, 8)]); // 双密钥 3DES：K3 = K1
    cipherName = 'des-ede3';
  }

  const block = cipher === 'aes' ? 16 : 8;
  const isStream = mode === 'cfb' || mode === 'ctr' || mode === 'ofb';
  let iv: crypto.BinaryLike | null = null;
  if (mode !== 'ecb') {
    if (p.iv) {
      const raw = toBytes(p.iv, p.ivEnc || 'utf8');
      if (raw.length !== block) {
        return { ok: false, error: `${mode.toUpperCase()} 的 IV 须为 ${block} 字节（当前 ${raw.length}，检查 IV 值或 IV 编码方式）` };
      }
      iv = raw;
    } else {
      iv = new Uint8Array(block); // 空 IV 按全零（EAS/老系统常见约定）
    }
  }

  try {
    const c = (action === 'encrypt'
      ? crypto.createCipheriv(`${cipherName}-${mode}`, keyBytes, mode === 'ecb' ? null : iv)
      : crypto.createDecipheriv(`${cipherName}-${mode}`, keyBytes, mode === 'ecb' ? null : iv));

    let out: Buffer;
    if (isStream) {
      c.setAutoPadding(false);
      if (action === 'encrypt') {
        const data = toBytes(p.input ?? '', 'utf8');
        out = Buffer.concat([c.update(data), c.final()]);
      } else {
        const rawCipher = toBytes(p.input ?? '', outEnc === 'utf8' ? 'utf8' : outEnc);
        out = Buffer.concat([c.update(rawCipher), c.final()]);
      }
      // 加密→密文按 outEnc 输出；解密→明文按 utf8 输出
      return { ok: true, text: action === 'decrypt' ? out.toString('utf8') : bytesToText(out, outEnc) };
    }

    if (action === 'encrypt') {
      const data = toBytes(p.input ?? '', 'utf8');
      if (pad === 'none') {
        if (data.length % block !== 0) {
          return { ok: false, error: `NoPadding 时明文长度须为块大小 ${block} 的整数倍（当前 ${data.length} 字节）` };
        }
        c.setAutoPadding(false);
        out = Buffer.concat([c.update(data), c.final()]);
      } else if (pad === 'pkcs7') {
        c.setAutoPadding(true);
        out = Buffer.concat([c.update(data), c.final()]);
      } else {
        c.setAutoPadding(false);
        out = Buffer.concat([c.update(manualPad(data, block, pad)), c.final()]);
      }
      return { ok: true, text: bytesToText(out, outEnc) };
    }

    // 解密
    const rawCipher = toBytes(p.input ?? '', outEnc === 'utf8' ? 'utf8' : outEnc);
    if (pad === 'pkcs7') c.setAutoPadding(true);
    else c.setAutoPadding(false);
    out = Buffer.concat([c.update(rawCipher), c.final()]);
    if (pad === 'zero' || pad === 'iso97971' || pad === 'anix923' || pad === 'iso10126') {
      out = Buffer.from(manualUnpad(new Uint8Array(out), block, pad));
    }
    // 解密结果 = 明文字节，按 utf8 出文本（outEnc 只描述密文的进/出格式，不作用于明文）
    return { ok: true, text: out.toString('utf8') };
  } catch (e: any) {
    const msg = String(e?.message || e);
    if (/bad decrypt|wrong final block/i.test(msg)) {
      return { ok: false, error: '解密失败（bad decrypt）：密钥/IV 不匹配、填充方式选错、或流模式密文长度不是块大小整数倍' };
    }
    return { ok: false, error: `加解密失败: ${msg}` };
  }
}

// ─── 字符编码（GBK / GB18030 / Big5 / UTF-8）───────────
/**
 * 用"中"字双向探测（编码+解码都须正确）：GBK/GB18030=D6D0（GB18030 两字节与 GBK 兼容）、Big5=A4A4。
 * 探测不到（编辑器 Node 构建缺 ICU 字符集）时返回 false，调用方给用户明确提示，不静默降级。
 */
function charsetProbe(): Record<string, boolean> {
  const out: Record<string, boolean> = { utf8: true };
  const probes: Array<[CharsetName, string]> = [
    ['gbk', 'd6d0'],
    ['gb18030', 'd6d0'],
    ['big5', 'a4a4'],
  ];
  for (const [name, hex] of probes) {
    try {
      const dec = new util.TextDecoder(name);
      const enc = new (util.TextEncoder as any)(name); // Node≥18 运行时支持编码标签，类型声明尚未跟上
      out[name] = dec.decode(hexToBytes(hex)) === '中' && bytesToHex(enc.encode('中')) === hex;
    } catch {
      out[name] = false;
    }
  }
  return out;
}

function doCharset(p: CryptoOpsPayload): CryptoOpsResult {
  const cs = (p.charset || 'utf8') as CharsetName;
  const supported = charsetProbe();
  if (!supported[cs]) {
    return {
      ok: false,
      error: `当前编辑器的 Node 运行时不支持 ${cs.toUpperCase()} 编码（ICU 缺该字符集）。请改用官方完整版编辑器，或先转成 UTF-8 再处理`,
      supports: supported,
    };
  }
  try {
    if (p.charsetAction === 'toBytes') {
      const b = cs === 'utf8' ? Buffer.from(p.input ?? '', 'utf8') : Buffer.from(new (util.TextEncoder as any)(cs).encode(p.input ?? ''));
      return { ok: true, text: bytesToHex(new Uint8Array(b)), supports: supported };
    }
    if (p.charsetAction === 'fromBytes') {
      const b = hexToBytes(p.input ?? '');
      const t = cs === 'utf8' ? Buffer.from(b).toString('utf8') : new util.TextDecoder(cs).decode(b);
      return { ok: true, text: t, supports: supported };
    }
    return { ok: false, error: 'charsetAction 必须是 toBytes 或 fromBytes' };
  } catch (e: any) {
    return { ok: false, error: `编码转换失败: ${e?.message || e}`, supports: supported };
  }
}

// ─── 随机数（全部走 crypto，不用 Math.random）──────────
const PWD_POOL = {
  upper: 'ABCDEFGHJKLMNPQRSTUVWXYZ',
  lower: 'abcdefghijkmnopqrstuvwxyz',
  digits: '23456789',
  symbols: '!@#$%^&*-_=+',
};

function doRandom(p: CryptoOpsPayload): CryptoOpsResult {
  switch (p.randomKind) {
    case 'uuid':
      return { ok: true, text: crypto.randomUUID() };
    case 'int': {
      const min = Math.max(0, Math.trunc(p.randomMin ?? 0));
      const max = Math.trunc(p.randomMax ?? 100);
      if (max < min) return { ok: false, error: '最大值不能小于最小值' };
      return { ok: true, text: String(crypto.randomInt(min, max + 1)) };
    }
    case 'bytes': {
      const n = Math.trunc(p.randomLength ?? 16);
      if (n <= 0 || n > 1024 * 1024) return { ok: false, error: '随机字节长度须在 1 ~ 1MB 之间' };
      return { ok: true, text: crypto.randomBytes(n).toString('base64') };
    }
    case 'password': {
      const len = Math.min(128, Math.max(4, Math.trunc(p.randomLength ?? 16)));
      const picks = p.randomChars || {};
      const active = [
        picks.upper !== false ? PWD_POOL.upper : '',
        picks.lower !== false ? PWD_POOL.lower : '',
        picks.digits !== false ? PWD_POOL.digits : '',
        picks.symbols !== false ? PWD_POOL.symbols : '',
      ].filter(Boolean);
      if (!active.length) return { ok: false, error: '至少勾选一类字符集' };
      const all = active.join('');
      const out = active.map((pool) => pool[crypto.randomInt(0, pool.length)]);
      while (out.length < len) out.push(all[crypto.randomInt(0, all.length)]);
      for (let i = out.length - 1; i > 0; i--) { // Fisher-Yates 洗牌
        const j = crypto.randomInt(0, i + 1);
        [out[i], out[j]] = [out[j], out[i]];
      }
      return { ok: true, text: out.join('') };
    }
    default:
      return { ok: false, error: 'randomKind 必须是 uuid / password / int / bytes' };
  }
}

// ─── 统一入口 ──────────────────────────────────────────
export function cryptoOps(p: CryptoOpsPayload): CryptoOpsResult {
  try {
    switch (p.op) {
      case 'hash': return doHash(p);
      case 'hmac': return doHmac(p);
      case 'symmetric': return doSymmetric(p);
      case 'charset': return doCharset(p);
      case 'charsetProbe': return { ok: true, supports: charsetProbe() };
      case 'random': return doRandom(p);
      default: return { ok: false, error: `未知运算: ${(p as any).op}` };
    }
  } catch (e: any) {
    return { ok: false, error: String(e?.message || e) };
  }
}
