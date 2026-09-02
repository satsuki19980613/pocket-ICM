import { readFileSync } from 'node:fs';
import { decodePng, type Raster } from './pngCodec.js';
import { whiteMask, binaryComponents } from '../src/numberField.js';
import type { Rgba } from '../src/color.js';
import type { Rect } from '../src/types.js';
const DIR='local-fixtures'; const f=(n:string)=>`${DIR}/Screenshot_20260901-${n}.png`;
const toRgba=(r:Raster):Rgba=>({w:r.width,h:r.height,data:r.rgba});
const px=(r:Raster,fr:readonly number[]):Rect=>({x:Math.round(fr[0]!*r.width),y:Math.round(fr[1]!*r.height),w:Math.round(fr[2]!*r.width),h:Math.round(fr[3]!*r.height)});
function tagBox(img:Raster, fr:readonly number[], minCh:number, maxSat:number){
  const rgba=toRgba(img); const rect=px(img,fr);
  const mask=whiteMask(rgba,rect,{minCh,maxSat});
  const comps=binaryComponents(mask);
  let px0=1e9,py0=1e9,px1=-1,py1=-1,area=0;
  for(const c of comps){px0=Math.min(px0,c.x);py0=Math.min(py0,c.y);px1=Math.max(px1,c.x+c.w);py1=Math.max(py1,c.y+c.h);area+=c.w*c.h;}
  return {comps:comps.length, bbox: comps.length?`${px1-px0}x${py1-py0}@(${px0},${py0})`:'-', area};
}
const cases:[string,string,readonly number[]][]=[
  ['fold(TL)','142820',[0.15,0.09,0.16,0.06]],
  ['raise(TR)','142826',[0.68,0.09,0.17,0.06]],
  ['call(TR)','101510',[0.66,0.09,0.17,0.065]],
  ['allin(hero)','101510',[0.35,0.545,0.20,0.055]],
  ['check(TC)','143035',[0.43,0.03,0.16,0.06]],
  ['NONE(TC)','142820',[0.43,0.03,0.16,0.06]],
  ['NONE(TR)','142820',[0.68,0.09,0.17,0.06]],
];
for(const [minCh,maxSat] of [[95,110],[105,100]] as const){
  console.log(`\n--- minCh=${minCh} maxSat=${maxSat} ---`);
  for(const [name,fr,zone] of cases){const img=decodePng(readFileSync(f(fr)));const t=tagBox(img,zone,minCh,maxSat);console.log(`${name.padEnd(13)} comps=${String(t.comps).padStart(3)} area=${String(t.area).padStart(5)} bbox=${t.bbox}`);}
}
