// Generates the test corpus as RGBA PNGs into corpus/.
// Deterministic (seeded PRNG) so results are reproducible across runs.
// The pixel generators live in content.ts, shared with the browser benchmark
// probe and the demo sample suite.

import { mkdirSync } from "node:fs";
import { join } from "node:path";
import sharp from "sharp";
import { GENERATORS } from "./content.ts";

export interface CorpusImage {
  name: string;
  width: number;
  height: number;
  /** RGBA, width * height * 4 */
  rgba: Uint8Array;
}

const SIZES: Array<[number, number]> = [
  [96, 96],
  [128, 128],
  [256, 256],
  [512, 512],
  [100, 75], // non-multiple-of-16: exercises macroblock edge padding
];

export function generateCorpus(): CorpusImage[] {
  const out: CorpusImage[] = [];
  for (const [name, gen] of Object.entries(GENERATORS)) {
    for (const [w, h] of SIZES) {
      out.push({ name: `${name}-${w}x${h}`, width: w, height: h, rgba: gen(w, h) });
    }
  }
  return out;
}

export const CORPUS_DIR = join(import.meta.dirname, "..", "corpus");

export async function writeCorpus(): Promise<CorpusImage[]> {
  mkdirSync(CORPUS_DIR, { recursive: true });
  const images = generateCorpus();
  await Promise.all(
    images.map((img) =>
      sharp(Buffer.from(img.rgba), {
        raw: { width: img.width, height: img.height, channels: 4 },
      })
        .png()
        .toFile(join(CORPUS_DIR, `${img.name}.png`)),
    ),
  );
  return images;
}

if (process.argv[1] === import.meta.filename) {
  const images = await writeCorpus();
  console.log(`wrote ${images.length} corpus images to ${CORPUS_DIR}`);
}
