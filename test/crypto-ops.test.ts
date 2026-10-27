import { describe, it, expect } from 'vitest';
import { cryptoOps } from '../src/host/crypto-ops';

/** 宿主侧密码学/字符编码运算。
 * 二进制正确性用「加解密往返 + 已知哈希值」锁定，避免依赖易记错的固定密文向量。 */
const KEY = '0123456789abcdef'; // 16 字节 AES-128
const IV = 'fedcba9876543210'; // 16 字节
const PT = 'hello dev-toolbox EAS 报文 12345';

describe('hash / hmac 已知值', () => {
  it('md5/sha1/sha256/sha512 与公认值一致', () => {
    expect(cryptoOps({ op: 'hash', algorithm: 'md5', input: 'abc' }).text).toBe('900150983cd24fb0d6963f7d28e17f72');
    expect(cryptoOps({ op: 'hash', algorithm: 'sha1', input: 'abc' }).text).toBe('a9993e364706816aba3e25717850c26c9cd0d89d');
    expect(cryptoOps({ op: 'hash', algorithm: 'sha256', input: 'abc' }).text).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
    expect(cryptoOps({ op: 'hash', algorithm: 'sha512', input: 'abc' }).text).toBe(
      'ddaf35a193617abacc417349ae20413112e6fa4e89a97ea20a9eeee64b55d39a2192992a274fc1a836ba3c23a3feebbd454d4423643ce80e2a9ac94fa54ca49f');
  });
  it('未知哈希算法明确报错', () => {
    const r = cryptoOps({ op: 'hash', algorithm: 'md4', input: 'x' }) as any;
    expect(r.ok).toBe(false);
    expect(r.error).toContain('不支持');
  });
  it('hmac-sha256 与公认值一致', () => {
    const r = cryptoOps({ op: 'hmac', algorithm: 'sha256', key: 'key', input: 'The quick brown fox jumps over the lazy dog' });
    expect(r.text).toBe('f7bc83f430538424b13298e6aa6fb143ef4d59a14946175997479dbc2d1a3cd8');
  });
});

describe('AES 对称加解密（往返锁定）', () => {
  it('cbc+pkcs7 非整块明文 往返一致（base64/hex 输出）', async () => {
    for (const outEnc of ['base64', 'hex'] as const) {
      const enc = cryptoOps({ op: 'symmetric', action: 'encrypt', cipher: 'aes', mode: 'cbc', padding: 'pkcs7', key: KEY, keyEnc: 'utf8', iv: IV, ivEnc: 'utf8', outEnc, input: PT }) as any;
      expect(enc.ok).toBe(true);
      const dec = cryptoOps({ op: 'symmetric', action: 'decrypt', cipher: 'aes', mode: 'cbc', padding: 'pkcs7', key: KEY, keyEnc: 'utf8', iv: IV, ivEnc: 'utf8', outEnc, input: enc.text }) as any;
      expect(dec.ok).toBe(true);
      expect(dec.text).toBe(PT);
    }
  });
  it('各填充（zero/iso10126）块模式往返一致，密文为整块', () => {
    for (const pad of ['zero', 'iso97971', 'anix923', 'iso10126'] as const) {
      const enc = cryptoOps({ op: 'symmetric', action: 'encrypt', cipher: 'aes', mode: 'cbc', padding: pad, key: KEY, keyEnc: 'utf8', iv: IV, ivEnc: 'utf8', outEnc: 'hex', input: PT }) as any;
      expect(enc.ok).toBe(true);
      expect(enc.text.length % 32).toBe(0); // 16 字节块 = 32 hex
      const dec = cryptoOps({ op: 'symmetric', action: 'decrypt', cipher: 'aes', mode: 'cbc', padding: pad, key: KEY, keyEnc: 'utf8', iv: IV, ivEnc: 'utf8', outEnc: 'hex', input: enc.text }) as any;
      expect(dec.text).toBe(PT);
    }
  });
  it('noPadding 明文须为整块，否则明确报错；整块则往返一致', () => {
    const blockAligned = 'x'.repeat(16);
    const bad = cryptoOps({ op: 'symmetric', action: 'encrypt', cipher: 'aes', mode: 'cbc', padding: 'none', key: KEY, keyEnc: 'utf8', iv: IV, ivEnc: 'utf8', outEnc: 'hex', input: 'short' }) as any;
    expect(bad.ok).toBe(false);
    expect(bad.error).toContain('NoPadding');
    const okEnc = cryptoOps({ op: 'symmetric', action: 'encrypt', cipher: 'aes', mode: 'cbc', padding: 'none', key: KEY, keyEnc: 'utf8', iv: IV, ivEnc: 'utf8', outEnc: 'hex', input: blockAligned }) as any;
    expect(okEnc.ok).toBe(true);
    const okDec = cryptoOps({ op: 'symmetric', action: 'decrypt', cipher: 'aes', mode: 'cbc', padding: 'none', key: KEY, keyEnc: 'utf8', iv: IV, ivEnc: 'utf8', outEnc: 'hex', input: okEnc.text }) as any;
    expect(okDec.text).toBe(blockAligned);
  });
  it('流模式 cfb/ctr/ofb 无块约束，任意长度明文往返一致', () => {
    for (const m of ['cfb', 'ctr', 'ofb'] as const) {
      const enc = cryptoOps({ op: 'symmetric', action: 'encrypt', cipher: 'aes', mode: m, padding: 'none', key: KEY, keyEnc: 'utf8', iv: IV, ivEnc: 'utf8', outEnc: 'base64', input: PT }) as any;
      expect(enc.ok).toBe(true);
      const dec = cryptoOps({ op: 'symmetric', action: 'decrypt', cipher: 'aes', mode: m, padding: 'none', key: KEY, keyEnc: 'utf8', iv: IV, ivEnc: 'utf8', outEnc: 'base64', input: enc.text }) as any;
      expect(dec.text).toBe(PT);
    }
  });
  it('ecb 无 IV 仍可往返', () => {
    const enc = cryptoOps({ op: 'symmetric', action: 'encrypt', cipher: 'aes', mode: 'ecb', padding: 'pkcs7', key: KEY, keyEnc: 'utf8', outEnc: 'base64', input: PT }) as any;
    expect(enc.ok).toBe(true);
    const dec = cryptoOps({ op: 'symmetric', action: 'decrypt', cipher: 'aes', mode: 'ecb', padding: 'pkcs7', key: KEY, keyEnc: 'utf8', outEnc: 'base64', input: enc.text }) as any;
    expect(dec.text).toBe(PT);
  });
  it('密钥长度非法/空 明确报错', () => {
    expect((cryptoOps({ op: 'symmetric', action: 'encrypt', cipher: 'aes', mode: 'cbc', padding: 'pkcs7', key: 'A'.repeat(15), keyEnc: 'utf8', iv: IV, ivEnc: 'utf8', input: 'x' }) as any).ok).toBe(false);
    expect((cryptoOps({ op: 'symmetric', action: 'encrypt', cipher: 'aes', mode: 'cbc', padding: 'pkcs7', key: '', keyEnc: 'utf8', input: 'x' }) as any).error).toContain('密钥为空');
  });
  it('错误 IV 长度 明确报错', () => {
    const r = cryptoOps({ op: 'symmetric', action: 'encrypt', cipher: 'aes', mode: 'cbc', padding: 'pkcs7', key: KEY, keyEnc: 'utf8', iv: 'toolong', ivEnc: 'utf8', input: 'x' }) as any;
    expect(r.ok).toBe(false);
    expect(r.error).toContain('IV');
  });
  it('密钥可用 base64/hex 编码提供，结果与 utf8 等价', () => {
    const keyB64 = Buffer.from(KEY, 'utf8').toString('base64');
    const keyHex = Buffer.from(KEY, 'utf8').toString('hex');
    const e1 = cryptoOps({ op: 'symmetric', action: 'encrypt', cipher: 'aes', mode: 'cbc', padding: 'pkcs7', key: KEY, keyEnc: 'utf8', iv: IV, ivEnc: 'utf8', outEnc: 'base64', input: PT }) as any;
    const e2 = cryptoOps({ op: 'symmetric', action: 'encrypt', cipher: 'aes', mode: 'cbc', padding: 'pkcs7', key: keyB64, keyEnc: 'base64', iv: IV, ivEnc: 'utf8', outEnc: 'base64', input: PT }) as any;
    const e3 = cryptoOps({ op: 'symmetric', action: 'encrypt', cipher: 'aes', mode: 'cbc', padding: 'pkcs7', key: keyHex, keyEnc: 'hex', iv: IV, ivEnc: 'utf8', outEnc: 'base64', input: PT }) as any;
    expect(e2.text).toBe(e1.text);
    expect(e3.text).toBe(e1.text);
  });
});

describe('DES / 3DES', () => {
  it('DES(8B) / 3DES(16B) cbc+pkcs7 往返一致', () => {
    const i8 = 'BBBBBBBB';
    for (const [cipher, ks] of [['des', 8], ['3des', 16]] as const) {
      const k = 'A'.repeat(ks);
      const enc = cryptoOps({ op: 'symmetric', action: 'encrypt', cipher: cipher as any, mode: 'cbc', padding: 'pkcs7', key: k, keyEnc: 'utf8', iv: i8, ivEnc: 'utf8', outEnc: 'base64', input: PT }) as any;
      expect(enc.ok).toBe(true);
      const dec = cryptoOps({ op: 'symmetric', action: 'decrypt', cipher: cipher as any, mode: 'cbc', padding: 'pkcs7', key: k, keyEnc: 'utf8', iv: i8, ivEnc: 'utf8', outEnc: 'base64', input: enc.text }) as any;
      expect(dec.text).toBe(PT);
    }
  });
  it('DES 密钥长度非 8 字节 报错', () => {
    expect((cryptoOps({ op: 'symmetric', action: 'encrypt', cipher: 'des', mode: 'cbc', padding: 'pkcs7', key: 'ABCDEF', keyEnc: 'utf8', iv: 'BBBBBBBB', ivEnc: 'utf8', input: 'x' }) as any).ok).toBe(false);
  });
});

describe('字符编码（含 ICU 缺集时的优雅降级）', () => {
  it('utf8 始终可用且往返一致', () => {
    const h = cryptoOps({ op: 'charset', charsetAction: 'toBytes', charset: 'utf8', input: '中文' }) as any;
    expect(h.ok).toBe(true);
    const t = cryptoOps({ op: 'charset', charsetAction: 'fromBytes', charset: 'utf8', input: h.text }) as any;
    expect(t.text).toBe('中文');
  });
  it('charsetProbe 返回各字符集支持情况；不支持的转码给明确错误而非静默失败', () => {
    const probe = cryptoOps({ op: 'charsetProbe' }) as any;
    expect(probe.ok).toBe(true);
    expect(probe.supports.utf8).toBe(true);
    for (const cs of ['gbk', 'gb18030', 'big5'] as const) {
      const r = cryptoOps({ op: 'charset', charsetAction: 'toBytes', charset: cs, input: '中' }) as any;
      if (probe.supports[cs]) {
        expect(r.ok).toBe(true);
        const back = cryptoOps({ op: 'charset', charsetAction: 'fromBytes', charset: cs, input: r.text }) as any;
        expect(back.text).toBe('中');
      } else {
        expect(r.ok).toBe(false);
        expect(r.error).toContain('不支持');
      }
    }
  });
});

describe('随机数（crypto 而非 Math.random）', () => {
  it('uuid 符合 v4 形态', () => {
    const r = cryptoOps({ op: 'random', randomKind: 'uuid' }) as any;
    expect(r.text).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
  });
  it('int 落在 [min,max] 闭区间', () => {
    for (let i = 0; i < 50; i++) {
      const r = cryptoOps({ op: 'random', randomKind: 'int', randomMin: 100, randomMax: 199 }) as any;
      const n = Number(r.text);
      expect(n).toBeGreaterThanOrEqual(100);
      expect(n).toBeLessThanOrEqual(199);
    }
  });
  it('password 长度/字符集约束满足（勾选哪些就只出现哪些）', () => {
    const r = cryptoOps({ op: 'random', randomKind: 'password', randomLength: 24, randomChars: { upper: true, lower: true, digits: true, symbols: false } }) as any;
    expect(r.text).toHaveLength(24);
    expect(r.text).toMatch(/^[A-Za-z0-9]+$/);
  });
  it('bytes 长度正确且为 base64', () => {
    const r = cryptoOps({ op: 'random', randomKind: 'bytes', randomLength: 32 }) as any;
    expect(Buffer.from(r.text, 'base64').length).toBe(32);
  });
  it('int 区间非法 报错', () => {
    expect((cryptoOps({ op: 'random', randomKind: 'int', randomMin: 200, randomMax: 100 }) as any).ok).toBe(false);
  });
});
