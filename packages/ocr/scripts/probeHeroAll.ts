import { readFileSync, existsSync } from 'node:fs';
import { decodePng, type Raster } from './pngCodec.js';
import { findCardRects } from '../src/detect.js';
import { recognizeCardColor } from '../src/cards.js';
import { grayFromRgba } from '../src/numberField.js';
import type { Template } from '../src/match.js';
import type { Rgba } from '../src/color.js';
import type { Rect } from '../src/types.js';
const DIR='local-fixtures';
function file(ts:string){for(const p of [`${DIR}/Screenshot_20260901-${ts}.png`,`${DIR}/Screenshot_20260902-${ts}.png`])if(existsSync(p))return p;throw new Error(ts);}
const toRgba=(r:Raster):Rgba=>({w:r.width,h:r.height,data:r.rgba});
const px=(r:Raster,fr:readonly number[]):Rect=>({x:Math.round(fr[0]!*r.width),y:Math.round(fr[1]!*r.height),w:Math.round(fr[2]!*r.width),h:Math.round(fr[3]!*r.height)});
const HERO=[0.425,0.655,0.105,0.150] as const;
const raw=JSON.parse(readFileSync(`${DIR}/ranks_hero.json`,"utf8")) as {templates:any[]};
const T:Template[]=(raw.templates as any[]).map(g=>({label:g.label,img:{w:g.w,h:g.h,data:Uint8Array.from(g.data)}}));
const norm=(r:string)=>r==='10'?'T':r;
// frame: [leftRank,rightRank]  (S=source, H=held-out)
const M:[string,string,string,string][]=[
 ['142820','5','A','S'],['115108','2','7','S'],['114437','10','4','S'],['114700','K','8','S'],['114808','5','3','S'],['115309','9','9','S'],['114922','6','6','S'],['114832','3','Q','S'],['123636','Q','J','S'],
 ['142909','10','9','H'],['143032','9','7','H'],['101510','J','K','H'],['103554','6','K','H'],['114522','7','K','H'],['114544','3','10','H'],['114640','J','4','H'],['114717','Q','J','H'],['114751','3','7','H'],['114951','6','8','H'],['115004','6','5','H'],['115121','7','A','H'],['123649','7','10','H'],['123717','A','5','H'],['123731','2','Q','H'],['124600','5','K','H'],['124738','K','3','H'],['115018','K','5','H'],
];
let ok=0,tot=0,hOk=0,hTot=0;
for(const [ts,lr,rr,kind] of M){
  const img=decodePng(readFileSync(file(ts)));const rgba=toRgba(img);const rect=px(img,HERO);
  const g=grayFromRgba(rgba,rect);
  const rects=findCardRects(g,{threshold:190,minAreaFrac:0.02,closeRadius:1}).map(r=>({x:rect.x+r.x,y:rect.y+r.y,w:r.w,h:r.h}));
  if(rects.length<2){console.log(`XX ${ts} cards=${rects.length}`);tot+=2;if(kind==='H')hTot+=2;continue;}
  const c0=recognizeCardColor(rgba,rects[0]!,T), c1=recognizeCardColor(rgba,rects[1]!,T);
  const g0=c0.value.slice(0,-1), g1=c1.value.slice(0,-1);
  const e0=norm(lr),e1=norm(rr);
  const ok0=g0===e0, ok1=g1===e1;
  ok+=(ok0?1:0)+(ok1?1:0);tot+=2; if(kind==='H'){hOk+=(ok0?1:0)+(ok1?1:0);hTot+=2;}
  console.log(`${ok0&&ok1?'OK':'XX'} ${kind} ${ts} exp=${e0},${e1} got=${g0}(${c0.conf.toFixed(2)}),${g1}(${c1.conf.toFixed(2)})`);
}
console.log(`\nランク一致(全): ${ok}/${tot}  ホールドアウトのみ: ${hOk}/${hTot}`);
