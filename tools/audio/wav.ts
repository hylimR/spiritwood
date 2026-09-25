import { writeFileSync } from 'node:fs';

/** Write float channels (−1..1, clipped) as a 16-bit PCM WAV with TPDF dither. */
export function writeWav16(path: string, channels: readonly Float32Array[], sampleRate: number): void {
  const nch = channels.length;
  const len = channels[0]?.length ?? 0;
  const data = Buffer.alloc(len * nch * 2);
  let seed = 0x12345678;
  const rnd = (): number => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    return seed / 4294967296;
  };
  for (let i = 0; i < len; i++) {
    for (let c = 0; c < nch; c++) {
      const x = (channels[c] as Float32Array)[i] as number;
      const d = (rnd() - rnd()) / 32768;
      const v = Math.max(-1, Math.min(1, x + d));
      data.writeInt16LE(Math.round(v * 32767), (i * nch + c) * 2);
    }
  }
  const header = Buffer.alloc(44);
  header.write('RIFF', 0, 'ascii');
  header.writeUInt32LE(36 + data.length, 4);
  header.write('WAVE', 8, 'ascii');
  header.write('fmt ', 12, 'ascii');
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(nch, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * nch * 2, 28);
  header.writeUInt16LE(nch * 2, 32);
  header.writeUInt16LE(16, 34);
  header.write('data', 36, 'ascii');
  header.writeUInt32LE(data.length, 40);
  writeFileSync(path, Buffer.concat([header, data]));
}
