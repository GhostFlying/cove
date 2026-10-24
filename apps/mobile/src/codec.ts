import type { Utf8Codec } from "@cove/client";

// Hermes versions differ in TextDecoder/fatal support. These bounded native
// adapter codecs do not depend on Node Buffer or on browser-only globals.
const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

export function encodeBase64(bytes: Uint8Array): string {
  const out: string[] = [];
  for (let i = 0; i < bytes.length; i += 3) {
    const a = bytes[i]!;
    const b = bytes[i + 1] ?? 0;
    const c = bytes[i + 2] ?? 0;
    out.push(
      alphabet[a >> 2]!,
      alphabet[((a & 3) << 4) | (b >> 4)]!,
      i + 1 < bytes.length ? alphabet[((b & 15) << 2) | (c >> 6)]! : "=",
      i + 2 < bytes.length ? alphabet[c & 63]! : "=",
    );
  }
  return out.join("");
}

export function decodeBase64(text: string, maximum: number): Uint8Array {
  if (text.length % 4 !== 0 || text.length > Math.ceil(maximum / 3) * 4)
    throw new Error("Invalid native binary data");
  const padding = text.endsWith("==") ? 2 : text.endsWith("=") ? 1 : 0;
  for (let i = 0; i < text.length - padding; i++)
    if (alphabet.indexOf(text[i]!) < 0) throw new Error("Invalid native binary data");
  const length = (text.length / 4) * 3 - padding;
  if (length > maximum) throw new Error("Native binary data exceeded its bound");
  const out = new Uint8Array(length);
  let offset = 0;
  for (let i = 0; i < text.length; i += 4) {
    const a = alphabet.indexOf(text[i]!);
    const b = alphabet.indexOf(text[i + 1]!);
    const c = text[i + 2] === "=" ? 0 : alphabet.indexOf(text[i + 2]!);
    const d = text[i + 3] === "=" ? 0 : alphabet.indexOf(text[i + 3]!);
    if ((text[i + 2] === "=" && (b & 15) !== 0) || (text[i + 3] === "=" && (c & 3) !== 0))
      throw new Error("Noncanonical native binary data");
    out[offset++] = (a << 2) | (b >> 4);
    if (offset < length) out[offset++] = ((b & 15) << 4) | (c >> 2);
    if (offset < length) out[offset++] = ((c & 3) << 6) | d;
  }
  return out;
}

export const utf8: Utf8Codec = {
  encode(text) {
    const out: number[] = [];
    for (const char of text) {
      let point = char.codePointAt(0)!;
      if (point >= 0xd800 && point <= 0xdfff) point = 0xfffd;
      if (point < 0x80) out.push(point);
      else if (point < 0x800) out.push(0xc0 | (point >> 6), 0x80 | (point & 63));
      else if (point < 0x10000)
        out.push(0xe0 | (point >> 12), 0x80 | ((point >> 6) & 63), 0x80 | (point & 63));
      else
        out.push(
          0xf0 | (point >> 18),
          0x80 | ((point >> 12) & 63),
          0x80 | ((point >> 6) & 63),
          0x80 | (point & 63),
        );
    }
    return new Uint8Array(out);
  },
  decodeFatal(bytes) {
    const out: string[] = [];
    for (let i = 0; i < bytes.length;) {
      const start = i;
      const lead = bytes[i++]!;
      let point = lead;
      let tails = 0;
      let minimum = 0;
      if (lead >= 0xc2 && lead <= 0xdf) {
        point &= 31;
        tails = 1;
        minimum = 0x80;
      } else if (lead >= 0xe0 && lead <= 0xef) {
        point &= 15;
        tails = 2;
        minimum = 0x800;
      } else if (lead >= 0xf0 && lead <= 0xf4) {
        point &= 7;
        tails = 3;
        minimum = 0x10000;
      } else if (lead >= 0x80) throw new Error("Invalid native UTF-8");
      for (let n = 0; n < tails; n++) {
        const next = bytes[i++];
        if (next === undefined || next < 0x80 || next > 0xbf)
          throw new Error("Invalid native UTF-8");
        point = (point << 6) | (next & 63);
      }
      if (point < minimum || point > 0x10ffff || (point >= 0xd800 && point <= 0xdfff))
        throw new Error("Invalid native UTF-8");
      if (start !== 0 || point !== 0xfeff) out.push(String.fromCodePoint(point));
    }
    return out.join("");
  },
};
