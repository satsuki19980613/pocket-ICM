import { readFileSync } from 'node:fs';
import { decodePng, type Raster } from './pngCodec.js';
import { recognizeAction } from '../src/actionTag.js';
import type { Template } from '../src/match.js';
import type { Rgba } from '../src/color.js';
import type { Rect } from '../src/types.js';
const DIR='local-fixtures'; const f=(n:string)=>`${DIR}/Screenshot_20260901-${n}.png`;
const toRgba=(r:Raster):Rgba=>({w:r.width,h:r.height,data:r.rgba});
const px=(r:Raster,fr:readonly number[]):Rect=>({x:Math.round(fr[0]!*r.width),y:Math.round(fr[1]!*r.height),w:Math.round(fr[2]!*r.width),h:Math.round(fr[3]!*r.height)});
const raw=JSON.parse(readFileSync(`${DIR}/actions.json`,'utf8')) as {templates:{label:string;w:number;h:number;data:number[]}[]};
const T:Template[]=raw.templates.map(g=>({label:g.label,img:{w:g.w,h:g.h,data:Uint8Array.from(g.data)}}));
// 6席探索帯（割合）
const Z={TL:[0.15,0.09,0.17,0.065],TC:[0.43,0.03,0.16,0.065],TR:[0.66,0.09,0.17,0.065],BL:[0.09,0.51,0.17,0.06],BC:[0.35,0.545,0.22,0.06],BR:[0.77,0.51,0.17,0.06]} as const;
// [name, frame, seat, truth]  ※fold は none 期待（カード状態で別途）
const cases:[string,string,keyof typeof Z,string][]=[
  ['142826 TR raise','142826','TR','raise'],
  ['101510 TL raise','101510','TL','raise'],
  ['103554 BR raise','103554','BR','raise'],
  ['101510 TR call','101510','TR','call'],
  ['101510 hero allin','101510','BC','allin'],
  ['143035 TC check','143035','TC','check'],
  ['143035 TR check','143035','TR','check'],
  ['142826 TC fold->none','142826','TC','none'],
  ['142826 BR fold->none','142826','BR','none'],
  ['103554 hero fold->none','103554','BC','none'],
  ['142820 TR none','142820','TR','none'],
  ['142820 TC none','142820','TC','none'],
  ['142820 BR none','142820','BR','none'],
];
let ok=0,tot=0;
for(const [name,fr,seat,truth] of cases){const img=decodePng(readFileSync(f(fr)));const r=recognizeAction(toRgba(img),px(img,Z[seat]),T);const good=r.value===truth;if(good)ok++;tot++;console.log(`${good?'OK':'XX'} ${name.padEnd(24)} truth=${truth.padEnd(6)} got=${r.value.padEnd(6)} conf=${r.conf.toFixed(2)}`);}
console.log(`\n一致: ${ok}/${tot}`);
