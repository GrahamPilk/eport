// node scripts/og.cjs → public/og.png (re-run after changing your name)
const { chromium } = require('playwright');
const name = require('fs').readFileSync(__dirname + '/../src/site.config.mjs', 'utf8').match(/name:\s*'([^']+)'/)[1];
(async () => {
  const b = await chromium.launch(); const p = await b.newPage({ viewport: { width: 1200, height: 630 } });
  await p.setContent(`<canvas id=c width=300 height=158 style="width:1200px;height:630px;image-rendering:pixelated;display:block"></canvas>
  <script>const B=[0,32,8,40,2,34,10,42,48,16,56,24,50,18,58,26,12,44,4,36,14,46,6,38,60,28,52,20,62,30,54,22,3,35,11,43,1,33,9,41,51,19,59,27,49,17,57,25,15,47,7,39,13,45,5,37,63,31,55,23,61,29,53,21];
  const c=document.getElementById('c').getContext('2d'),W=300,H=158,im=c.createImageData(W,H);
  for(let y=0;y<H;y++)for(let x=0;x<W;x++){const d=Math.hypot(x-230,(y-80)*1.1)/150;const v=Math.min(1,Math.max(0,d));const on=v>(B[(y&7)*8+(x&7)]+.5)/64;const i=(y*W+x)*4;const k=on?255:0;im.data[i]=im.data[i+1]=im.data[i+2]=k;im.data[i+3]=255}
  c.putImageData(im,0,0);</script>
  <div style="position:absolute;left:72px;top:200px;background:#fff;padding:24px 32px;border:6px solid #000;font:700 96px/1 Atkinson,system-ui,sans-serif;letter-spacing:-3px">${name}</div>`);
  await p.addStyleTag({ content: "@font-face{font-family:Atkinson;src:url(data:font/woff2;base64," + require('fs').readFileSync(__dirname + '/../public/fonts/atkinson-hyperlegible-latin-700-normal.woff2').toString('base64') + ")}body{margin:0}" });
  await p.waitForTimeout(300); await p.screenshot({ path: __dirname + '/../public/og.png' }); await b.close();
})();
