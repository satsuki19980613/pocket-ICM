/** hero手札ランクテンプレ（多例, プレイ画面）。左右の席で札幾何が違うので両位置・複数フレームから収集。 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { decodePng, type Raster } from './pngCodec.js';
import { findCardRects, cornerOf } from '../src/detect.js';
import { grayFromRgba } from '../src/numberField.js';
import { resize } from '../src/raster.js';
import type { Rgba } from '../src/color.js';
import type { Rect } from '../src/types.js';
const DIR='local-fixtures';
function file(ts:string){for(const p of [`${DIR}/Screenshot_20260901-${ts}.png`,`${DIR}/Screenshot_20260902-${ts}.png`])if(existsSync(p))return p;throw new Error(ts);}
const toRgba=(r:Raster):Rgba=>({w:r.width,h:r.height,data:r.rgba});
const px=(r:Raster,fr:readonly number[]):Rect=>({x:Math.round(fr[0]!*r.width),y:Math.round(fr[1]!*r.height),w:Math.round(fr[2]!*r.width),h:Math.round(fr[3]!*r.height)});
const HERO=[0.425,0.655,0.105,0.150] as const; const CW=30,CH=38;
const SPECS:[string,0|1,string][]=[
 ['142820',0,'5'],['114808',0,'5'],['124600',0,'5'],
 ['142820',1,'A'],['123717',0,'A'],['124723',0,'A'],
 ['115108',0,'2'],['123731',0,'2'],
 ['115108',1,'7'],['114751',1,'7'],['123649',0,'7'],
 ['114437',0,'10'],['114544',1,'10'],['114732',0,'10'],
 ['114437',1,'4'],['114640',1,'4'],['124723',1,'4'],
 ['114700',0,'K'],['114522',1,'K'],['124738',0,'K'],
 ['114700',1,'8'],['114951',1,'8'],['115034',0,'8'],
 ['114808',1,'3'],['123704',0,'3'],['124738',1,'3'],
 ['115309',0,'9'],['142909',1,'9'],['124645',0,'9'],
 ['114922',0,'6'],['114951',0,'6'],['124645',1,'6'],
 ['114832',1,'Q'],['114717',0,'Q'],['123731',1,'Q'],
 ['123636',1,'J'],['114640',0,'J'],['114717',1,'J'],
];
function heroCards(ts:string){const img=decodePng(readFileSync(file(ts)));const rgba=toRgba(img);const rect=px(img,HERO);const g=grayFromRgba(rgba,rect);const rects=findCardRects(g,{threshold:190,minAreaFrac:0.02,closeRadius:1}).map(r=>({x:rect.x+r.x,y:rect.y+r.y,w:r.w,h:r.h}));return{rgba,rects};}
const templates:{label:string;w:number;h:number;data:number[]}[]=[];
for(const [ts,idx,rank] of SPECS){const {rgba,rects}=heroCards(ts);if(rects.length<2){console.log(`XX ${ts} ${rank}: cards=${rects.length}`);continue;}const c=rects[idx]!;const rg=resize(grayFromRgba(rgba,cornerOf(c,0.5,0.42)),CW,CH);templates.push({label:rank,w:rg.w,h:rg.h,data:Array.from(rg.data)});}
writeFileSync(`${DIR}/ranks_hero.json`,JSON.stringify({source:'play hero cards (multi-exemplar)',templates}));
const byR:Record<string,number>={};for(const t of templates)byR[t.label]=(byR[t.label]||0)+1;
console.log(`wrote ${templates.length} exemplars:`,Object.entries(byR).map(([k,v])=>`${k}:${v}`).join(' '));
