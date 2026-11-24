/**
 * crc32.ts: the checksum ZIP files use to detect damaged data.
 *
 * Purpose: Verify every extracted file without any third-party library.
 * Usage:   let crc = CRC_START;
 *          crc = crc32Update(crc, bytes);
 *          const result = crc32Finish(crc);
 * Memory:  Works chunk by chunk, so large audio files never load all at once.
 */

/** Standard CRC-32 lookup table, built once when this module loads. */
const CRC_TABLE = new Uint32Array(256).map((_, index) => {
  let value = index;
  for (let bit = 0; bit < 8; bit += 1) {
    value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
  }
  return value;
});

/** Starting value for a running CRC-32. */
export const CRC_START = 0xffffffff;

/** Adds bytes to a running CRC-32. */
export function crc32Update(crc: number, bytes: Uint8Array): number {
  let value = crc;
  for (let index = 0; index < bytes.length; index += 1) {
    // The table has 256 entries, and the mask guarantees a valid index.
    value = CRC_TABLE[(value ^ bytes[index]!) & 0xff]! ^ (value >>> 8);
  }
  return value >>> 0;
}

/** Converts a running CRC-32 into its final value. */
export const crc32Finish = (crc: number): number => (crc ^ CRC_START) >>> 0;

/** Calculates the CRC-32 of a saved file. */
export async function crc32OfBlob(blob: Blob): Promise<number> {
  const reader = blob.stream().getReader();
  let crc = CRC_START;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) return crc32Finish(crc);
    crc = crc32Update(crc, value);
  }
}
