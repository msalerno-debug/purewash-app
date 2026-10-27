// Converts telephone-style WAV (µ-law or A-law, 8-bit) into standard 16-bit PCM WAV,
// which every browser can play. Other WAV encodings are returned unchanged.
function ulaw(u: number): number {
  u = ~u & 0xff;
  const sign = u & 0x80, exponent = (u >> 4) & 0x07, mantissa = u & 0x0f;
  let s = ((mantissa << 3) + 0x84) << exponent;
  s -= 0x84;
  return sign ? -s : s;
}
function alaw(a: number): number {
  a ^= 0x55;
  let t = (a & 0x0f) << 4;
  const seg = (a & 0x70) >> 4;
  if (seg === 0) t += 8;
  else if (seg === 1) t += 0x108;
  else { t += 0x108; t <<= seg - 1; }
  return (a & 0x80) ? t : -t;
}
export function toPcmWav(buf: Uint8Array): { bytes: Uint8Array; converted: boolean; format: number | null; seconds: number | null } {
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const tag = (o: number) => String.fromCharCode(buf[o], buf[o + 1], buf[o + 2], buf[o + 3]);
  if (buf.length < 12 || tag(0) !== "RIFF" || tag(8) !== "WAVE") return { bytes: buf, converted: false, format: null, seconds: null };
  let off = 12, fmt: { format: number; ch: number; rate: number; bits: number } | null = null, dataOff = -1, dataLen = 0;
  while (off + 8 <= buf.length) {
    const id = tag(off), len = dv.getUint32(off + 4, true);
    if (id === "fmt ") fmt = { format: dv.getUint16(off + 8, true), ch: dv.getUint16(off + 10, true), rate: dv.getUint32(off + 12, true), bits: dv.getUint16(off + 22, true) };
    if (id === "data") { dataOff = off + 8; dataLen = Math.min(len, buf.length - dataOff); break; }
    off += 8 + len + (len & 1);
  }
  if (!fmt || dataOff < 0) return { bytes: buf, converted: false, format: fmt?.format ?? null, seconds: null };
  const seconds = fmt.rate && fmt.ch && fmt.bits ? dataLen / (fmt.rate * fmt.ch * (fmt.bits / 8)) : null;
  if (fmt.format !== 7 && fmt.format !== 6) return { bytes: buf, converted: false, format: fmt.format, seconds };
  const dec = fmt.format === 7 ? ulaw : alaw;
  const n = dataLen, out = new Uint8Array(44 + n * 2), o = new DataView(out.buffer);
  const w = (p: number, s: string) => { for (let i = 0; i < 4; i++) out[p + i] = s.charCodeAt(i); };
  w(0, "RIFF"); o.setUint32(4, 36 + n * 2, true); w(8, "WAVE");
  w(12, "fmt "); o.setUint32(16, 16, true); o.setUint16(20, 1, true); o.setUint16(22, fmt.ch, true);
  o.setUint32(24, fmt.rate, true); o.setUint32(28, fmt.rate * fmt.ch * 2, true); o.setUint16(32, fmt.ch * 2, true); o.setUint16(34, 16, true);
  w(36, "data"); o.setUint32(40, n * 2, true);
  for (let i = 0; i < n; i++) o.setInt16(44 + i * 2, dec(buf[dataOff + i]), true);
  return { bytes: out, converted: true, format: fmt.format, seconds };
}
