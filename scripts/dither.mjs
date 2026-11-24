// 1-bit ordered dither for your photos.
//   npm run dither -- in.jpg public/img/me.png [width=640]
// Output is a 1-bit-looking PNG (pure #000/#fff). Use it with image-rendering: pixelated.
import sharp from 'sharp';
const [, , input, output, w = '640'] = process.argv;
if (!input || !output) { console.error('usage: npm run dither -- <in> <out.png> [width]'); process.exit(1); }
const B = [0,32,8,40,2,34,10,42,48,16,56,24,50,18,58,26,12,44,4,36,14,46,6,38,60,28,52,20,62,30,54,22,
  3,35,11,43,1,33,9,41,51,19,59,27,49,17,57,25,15,47,7,39,13,45,5,37,63,31,55,23,61,29,53,21];
const { data, info } = await sharp(input).resize({ width: Number(w) }).greyscale().normalise().linear(1.15, -10)
  .raw().toBuffer({ resolveWithObject: true });
const out = Buffer.alloc(info.width * info.height);
for (let y = 0; y < info.height; y++) for (let x = 0; x < info.width; x++) {
  const i = y * info.width + x;
  out[i] = data[i] / 255 > (B[(y & 7) * 8 + (x & 7)] + 0.5) / 64 ? 255 : 0;
}
await sharp(out, { raw: { width: info.width, height: info.height, channels: 1 } }).png({ palette: true, colours: 2 }).toFile(output);
console.log(`→ ${output} (${info.width}×${info.height})`);
