/**
 * Generates the PWA icons — a checkmark on the accent colour.
 *
 * Hand-rolled PNG encoding so there's no image dependency for something that
 * runs once. Swap in a real design whenever you have one; just keep the sizes.
 *
 *   node scripts/make-icons.mjs
 */
import { deflateSync } from 'node:zlib';
import { writeFileSync, mkdirSync } from 'node:fs';

// Ink on off-white, matching the site. A dark field reads better than a light
// one at home-screen size, so the palette is inverted relative to the page.
const BG = [0x16, 0x16, 0x1a]; // --fg
const FG = [0xfc, 0xfc, 0xfa]; // --bg

const crcTable = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

function crc32(buf) {
  let c = 0xffffffff;
  for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

/** Distance from point p to segment ab, all normalised to 0..1. */
function distToSeg(px, py, ax, ay, bx, by) {
  const dx = bx - ax;
  const dy = by - ay;
  const t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / (dx * dx + dy * dy)));
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}

function png(size) {
  const half = 0.5 / size; // half-pixel, for cheap antialiasing
  const raw = Buffer.alloc(size * (size * 4 + 1));
  let o = 0;

  for (let y = 0; y < size; y++) {
    raw[o++] = 0; // filter: none
    for (let x = 0; x < size; x++) {
      const nx = (x + 0.5) / size;
      const ny = (y + 0.5) / size;

      // Checkmark: short down-stroke into a long up-stroke.
      const d = Math.min(
        distToSeg(nx, ny, 0.28, 0.52, 0.44, 0.68),
        distToSeg(nx, ny, 0.44, 0.68, 0.74, 0.33),
      );
      const edge = 0.055;
      // Smooth the boundary over roughly one pixel.
      const a = Math.max(0, Math.min(1, (edge - d) / Math.max(half * 2, 0.004)));

      raw[o++] = Math.round(BG[0] + (FG[0] - BG[0]) * a);
      raw[o++] = Math.round(BG[1] + (FG[1] - BG[1]) * a);
      raw[o++] = Math.round(BG[2] + (FG[2] - BG[2]) * a);
      raw[o++] = 255;
    }
  }

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // colour type: RGBA
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

mkdirSync(new URL('../public/icons/', import.meta.url), { recursive: true });
for (const size of [180, 192, 512]) {
  const out = new URL(`../public/icons/icon-${size}.png`, import.meta.url);
  writeFileSync(out, png(size));
  console.log(`wrote public/icons/icon-${size}.png`);
}
