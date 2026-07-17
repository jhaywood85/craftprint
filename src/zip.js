// Minimal ZIP writer — enough to assemble a 3MF (which is a ZIP archive).
// Entries are STORED (uncompressed): valid ZIP, no deflate dependency, and
// 3MF models are small enough that size doesn't matter here.
//
// Produces a correct local-file-header + central-directory + end-of-central-
// directory structure with CRC-32 per entry.

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(bytes) {
  let c = ~0;
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (~c) >>> 0;
}

const enc = new TextEncoder();

/**
 * @param {Array<{name: string, data: string|Uint8Array}>} files
 * @returns {Uint8Array} the ZIP archive bytes
 */
export function makeZip(files) {
  const entries = files.map((f) => {
    const nameBytes = enc.encode(f.name);
    const dataBytes = typeof f.data === 'string' ? enc.encode(f.data) : f.data;
    return { nameBytes, dataBytes, crc: crc32(dataBytes), offset: 0 };
  });

  const chunks = [];
  let offset = 0;
  const push = (u8) => { chunks.push(u8); offset += u8.length; };

  const u16 = (n) => new Uint8Array([n & 0xff, (n >>> 8) & 0xff]);
  const u32 = (n) => new Uint8Array([n & 0xff, (n >>> 8) & 0xff, (n >>> 16) & 0xff, (n >>> 24) & 0xff]);

  // Local file headers + data.
  for (const e of entries) {
    e.offset = offset;
    push(u32(0x04034b50));           // local file header signature
    push(u16(20));                   // version needed
    push(u16(0));                    // flags
    push(u16(0));                    // compression: 0 = stored
    push(u16(0)); push(u16(0));      // mod time / date (0)
    push(u32(e.crc));                // crc-32
    push(u32(e.dataBytes.length));   // compressed size
    push(u32(e.dataBytes.length));   // uncompressed size
    push(u16(e.nameBytes.length));   // file name length
    push(u16(0));                    // extra field length
    push(e.nameBytes);
    push(e.dataBytes);
  }

  // Central directory.
  const cdStart = offset;
  for (const e of entries) {
    push(u32(0x02014b50));           // central dir header signature
    push(u16(20));                   // version made by
    push(u16(20));                   // version needed
    push(u16(0));                    // flags
    push(u16(0));                    // compression: stored
    push(u16(0)); push(u16(0));      // mod time / date
    push(u32(e.crc));
    push(u32(e.dataBytes.length));
    push(u32(e.dataBytes.length));
    push(u16(e.nameBytes.length));
    push(u16(0));                    // extra length
    push(u16(0));                    // comment length
    push(u16(0));                    // disk number start
    push(u16(0));                    // internal attrs
    push(u32(0));                    // external attrs
    push(u32(e.offset));             // local header offset
    push(e.nameBytes);
  }
  const cdSize = offset - cdStart;

  // End of central directory record.
  push(u32(0x06054b50));
  push(u16(0)); push(u16(0));        // disk numbers
  push(u16(entries.length));         // entries on this disk
  push(u16(entries.length));         // total entries
  push(u32(cdSize));
  push(u32(cdStart));
  push(u16(0));                      // comment length

  // Concatenate.
  const out = new Uint8Array(offset);
  let p = 0;
  for (const c of chunks) { out.set(c, p); p += c.length; }
  return out;
}
