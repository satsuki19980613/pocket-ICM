import { readFileSync } from 'node:fs';
import { decodePng, type Raster } from './pngCodec.js';
import { isActiveHand } from '../src/cardState.js';
import type { Rgba } from '../src/color.js';
import type { Rect } from '../src/types.js';
const DIR='local-fixtures'; const f=(n:string)=>`${DIR}/Screenshot_20260901-${n}.png`;
const toRgba=(r:Raster):Rgba=>({w:r.width,h:r.height,data:r.rgba});
const px=(r:Raster,fr:readonly number[]):Rect=>({x:Math.round(fr[0]!*r.width),y:Math.round(fr[1]!*r.height),w:Math.round(fr[2]!*r.width),h:Math.round(fr[3]!*r.height)});
const C={TL:[0.235,0.13,0.075,0.085],TC:[0.50,0.09,0.075,0.085],TR:[0.775,0.13,0.075,0.085],BR:[0.835,0.49,0.085,0.085]} as const;
// truth: active=true/false（142844 は実物照合で訂正: TL active, TC/TR/BR folded）
const cases:[string,string,keyof typeof C,boolean][]=[
  ['142820 TL','142820','TL',false],['142820 TC','142820','TC',true],['142820 TR','142820','TR',true],['142820 BR','142820','BR',true],
  ['142844 TL','142844','TL',true],['142844 TC','142844','TC',false],['142844 TR','142844','TR',false],['142844 BR','142844','BR',false],
];
let ok=0,tot=0;
for(const [name,fr,seat,truth] of cases){const img=decodePng(readFileSync(f(fr)));const r=isActiveHand(toRgba(img),px(img,C[seat]));const good=r.value===truth;if(good)ok++;tot++;console.log(`${good?'OK':'XX'} ${name} truth=${truth?'active':'folded'} got=${r.value?'active':'folded'} conf=${r.conf.toFixed(2)}`);}
console.log(`\nactive/folded 一致: ${ok}/${tot}`);
