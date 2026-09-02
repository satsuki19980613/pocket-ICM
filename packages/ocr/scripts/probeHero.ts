import { readFileSync } from 'node:fs';
import { decodePng, type Raster } from './pngCodec.js';
import { findCardRects } from '../src/detect.js';
import { recognizeCardColor, heroHandFromCards } from '../src/cards.js';
import { grayFromRgba } from '../src/numberField.js';
import type { Template } from '../src/match.js';
import type { Rgba } from '../src/color.js';
import type { Rect } from '../src/types.js';
const DIR='local-fixtures'; const f=(n:string)=>`${DIR}/Screenshot_20260901-${n}.png`;
const toRgba=(r:Raster):Rgba=>({w:r.width,h:r.height,data:r.rgba});
const px=(r:Raster,fr:readonly number[]):Rect=>({x:Math.round(fr[0]!*r.width),y:Math.round(fr[1]!*r.height),w:Math.round(fr[2]!*r.width),h:Math.round(fr[3]!*r.height)});
const raw=JSON.parse(readFileSync(`${DIR}/ranks.json`,'utf8')) as {templates:Record<string,{w:number;h:number;data:number[]}>};
const T:Template[]=Object.entries(raw.templates).map(([label,g])=>({label,img:{w:g.w,h:g.h,data:Uint8Array.from(g.data)}}));
const HERO=[0.425,0.655,0.105,0.150] as const;
for(const [n,truth] of [['142820','A5o (5h As)']] as const){
  const img=decodePng(readFileSync(f(n))); const rgba=toRgba(img); const rect=px(img,HERO);
  const g=grayFromRgba(rgba,rect);
  const rects=findCardRects(g,{threshold:190,minAreaFrac:0.02,closeRadius:1}).map(r=>({x:rect.x+r.x,y:rect.y+r.y,w:r.w,h:r.h}));
  console.log(`${n}: findCardRects=${rects.length}`);
  if(rects.length>=2){
    const c1=recognizeCardColor(rgba,rects[0]!,T), c2=recognizeCardColor(rgba,rects[1]!,T);
    console.log(`  card1=${c1.value}(${c1.conf.toFixed(2)}) card2=${c2.value}(${c2.conf.toFixed(2)}) hand=${heroHandFromCards(c1.value,c2.value)} truth=${truth}`);
  }
}
