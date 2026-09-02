import { readFileSync } from 'node:fs';
import { decodePng, type Raster } from './pngCodec.js';
const DIR='local-fixtures'; const f=(n:string)=>`${DIR}/Screenshot_20260901-${n}.png`;
function avg(img:Raster, fx:number,fy:number,fw:number,fh:number, label:string){
  const {width:W,height:H,rgba}=img;
  const x0=Math.round(fx*W),y0=Math.round(fy*H),w=Math.round(fw*W),h=Math.round(fh*H);
  let r=0,g=0,b=0,n=0; const hist:Record<string,number>={};
  for(let y=0;y<h;y++)for(let x=0;x<w;x++){const s=((y0+y)*W+(x0+x))*4;r+=rgba[s]!;g+=rgba[s+1]!;b+=rgba[s+2]!;n++;}
  console.log(`${label}: avg=(${(r/n|0)},${(g/n|0)},${(b/n|0)}) n=${n}`);
}
// オールイン plate (101510), フォールド bubble (142820 TL), レイズ plate (142826 TR), SBオーバル(142820), 緑フェルト
const a=decodePng(readFileSync(f('101510'))); avg(a,0.37,0.556,0.06,0.028,'allin_plate(purple)');
const b=decodePng(readFileSync(f('142820'))); avg(b,0.19,0.105,0.08,0.03,'fold_bubble'); avg(b,0.545,0.635,0.03,0.025,'SB_oval'); avg(b,0.5,0.45,0.03,0.03,'green_felt');
const c=decodePng(readFileSync(f('142826'))); avg(c,0.715,0.11,0.08,0.03,'raise_plate');
// 上段タグ無し背景 vs プレート（分離しきい値探索）
const d=decodePng(readFileSync(f('142820')));
avg(d,0.70,0.10,0.10,0.03,'TR_bg_notag(142820)');
avg(d,0.44,0.05,0.10,0.03,'TC_bg_notag(142820)');
const e=decodePng(readFileSync(f('142826')));
avg(e,0.715,0.11,0.06,0.025,'TR_raise_core');
