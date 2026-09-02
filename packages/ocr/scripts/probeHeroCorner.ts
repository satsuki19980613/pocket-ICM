import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { decodePng, encodePng, type Raster } from './pngCodec.js';
import { findCardRects } from '../src/detect.js';
import { cornerOf } from '../src/detect.js';
import { grayFromRgba } from '../src/numberField.js';
import type { Rgba } from '../src/color.js';
import type { Rect } from '../src/types.js';
const DIR='local-fixtures'; const f=(n:string)=>`${DIR}/Screenshot_20260901-${n}.png`;
const toRgba=(r:Raster):Rgba=>({w:r.width,h:r.height,data:r.rgba});
const px=(r:Raster,fr:readonly number[]):Rect=>({x:Math.round(fr[0]!*r.width),y:Math.round(fr[1]!*r.height),w:Math.round(fr[2]!*r.width),h:Math.round(fr[3]!*r.height)});
const out=process.argv[2]!; mkdirSync(out,{recursive:true});
function subRgba(img:Rgba, r:Rect):Raster{const rgba=new Uint8Array(r.w*r.h*4);for(let y=0;y<r.h;y++)for(let x=0;x<r.w;x++){const s=((r.y+y)*img.w+(r.x+x))*4,d=(y*r.w+x)*4;rgba[d]=img.data[s]!;rgba[d+1]=img.data[s+1]!;rgba[d+2]=img.data[s+2]!;rgba[d+3]=255;}return{width:r.w,height:r.h,rgba};}
const HERO=[0.425,0.655,0.105,0.150] as const;
const img=decodePng(readFileSync(f('142820'))); const rgba=toRgba(img); const rect=px(img,HERO);
const g=grayFromRgba(rgba,rect);
const rects=findCardRects(g,{threshold:190,minAreaFrac:0.02,closeRadius:1}).map(r=>({x:rect.x+r.x,y:rect.y+r.y,w:r.w,h:r.h}));
console.log('cards:',rects.length, rects.map(r=>`${r.w}x${r.h}@(${r.x},${r.y})`).join(' '));
rects.forEach((r,i)=>{
  writeFileSync(join(out,`card${i}.png`), encodePng(subRgba(rgba,r)));
  const c=cornerOf(r,0.5,0.42);
  writeFileSync(join(out,`corner${i}.png`), encodePng(subRgba(rgba,c)));
  console.log(`card${i} corner=${c.w}x${c.h}@(${c.x},${c.y})`);
});
