import { describe, expect, it } from 'vitest';

import { buildZip, crc32 } from './zip';

describe('crc32', () => {
  it('標準のチェック値', () => {
    expect(crc32(new TextEncoder().encode('123456789'))).toBe(0xcbf43926);
    expect(crc32(new Uint8Array(0))).toBe(0);
  });
});

describe('buildZip', () => {
  it('ローカルヘッダ・セントラルディレクトリ・EOCD が整合する', () => {
    const zip = buildZip(
      [
        { name: 'a/hello.json', data: '{"x":1}' },
        { name: 'b/日本語.txt', data: new Uint8Array([1, 2, 3]) },
      ],
      new Date(2026, 8, 15, 15, 20, 8),
    );
    const dv = new DataView(zip.buffer);
    expect(dv.getUint32(0, true)).toBe(0x04034b50);

    // EOCD は末尾 22 バイト。
    const eocd = zip.length - 22;
    expect(dv.getUint32(eocd, true)).toBe(0x06054b50);
    expect(dv.getUint16(eocd + 10, true)).toBe(2);
    const cdSize = dv.getUint32(eocd + 12, true);
    const cdOffset = dv.getUint32(eocd + 16, true);
    expect(cdOffset + cdSize).toBe(eocd);

    // セントラルディレクトリの 1 件目は先頭のローカルヘッダを指す。
    expect(dv.getUint32(cdOffset, true)).toBe(0x02014b50);
    expect(dv.getUint32(cdOffset + 42, true)).toBe(0);
    const nameLen = dv.getUint16(cdOffset + 28, true);
    expect(new TextDecoder().decode(zip.slice(cdOffset + 46, cdOffset + 46 + nameLen))).toBe('a/hello.json');
    expect(dv.getUint32(cdOffset + 16, true)).toBe(crc32(new TextEncoder().encode('{"x":1}')));
    // 時刻: 15:20:08 → (15<<11)|(20<<5)|4
    expect(dv.getUint16(cdOffset + 12, true)).toBe((15 << 11) | (20 << 5) | 4);
    // 日付: 2026-09-15 → ((2026-1980)<<9)|(9<<5)|15
    expect(dv.getUint16(cdOffset + 14, true)).toBe(((2026 - 1980) << 9) | (9 << 5) | 15);

    // 2 件目のローカルヘッダの位置 = 1 件目の長さ。
    const first = 30 + 'a/hello.json'.length + 7;
    expect(dv.getUint32(first, true)).toBe(0x04034b50);
    const cd2 = cdOffset + 46 + nameLen;
    expect(dv.getUint32(cd2 + 42, true)).toBe(first);
  });

  it('空でも壊れない', () => {
    const zip = buildZip([]);
    expect(zip.length).toBe(22);
    expect(new DataView(zip.buffer).getUint32(0, true)).toBe(0x06054b50);
  });
});
