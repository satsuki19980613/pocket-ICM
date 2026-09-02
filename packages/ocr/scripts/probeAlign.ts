import { readFileSync } from 'node:fs';
import { decodePng, type Raster } from './pngCodec.js';
import { recognizeAction, findTagBox } from '../src/actionTag.js';
import type { Template } from '../src/match.js';
import type { Rgba } from '../src/color.js';
import type { Rect } from '../src/types.js';
const DIR='local-fixtures'; const f=(n:string)=>`${DIR}/Screenshot_20260901-${n}.png`;
const toRgba=(r:Raster):Rgba=>({w:r.width,h:r.height,data:r.rgba});
const px=(r:Raster,fr:readonly number[]):Rect=>({x:Math.round(fr[0]!*r.width),y:Math.round(fr[1]!*r.height),w:Math.round(fr[2]!*r.width),h:Math.round(fr[3]!*r.height)});
const raw=JSON.parse(readFileSync(`${DIR}/actions.json`,'utf8')) as {templates:Record<string,{w:number;h:number;data:number[]}>};
const T:Template[]=Object.entries(raw.templates).map(([label,g])=>({label,img:{w:g.w,h:g.h,data:Uint8Array.from(g.data)}}));
// 各出現の密着帯（テンプレ生成帯と同じ）で認識できるか＝コア健全性
const cases:[string,string,string,readonly number[]][]=[
  ['raise 142826','142826','raise',[0.68,0.09,0.17,0.06]],
  ['call 101510','101510','call',[0.66,0.09,0.17,0.065]],
  ['allin 101510','101510','allin',[0.35,0.545,0.20,0.055]],
  ['check 143035','143035','check',[0.43,0.03,0.16,0.06]],
];
for(const [name,fr,truth,zone] of cases){const img=decodePng(readFileSync(f(fr)));const b=findTagBox(toRgba(img),px(img,zone));const r=recognizeAction(toRgba(img),px(img,zone),T);console.log(`${r.value===truth?'OK':'XX'} ${name.padEnd(14)} truth=${truth.padEnd(6)} got=${r.value.padEnd(6)} conf=${r.conf.toFixed(2)} box=${b?`${b.rect.w}x${b.rect.h}`:'-'}`);}
