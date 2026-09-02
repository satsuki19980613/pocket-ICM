import { readFileSync } from 'node:fs';
import { decodePng, type Raster } from './pngCodec.js';
import { connectedComponents } from '../src/detect.js';

const DIR='local-fixtures';
const f=(n:string)=>`${DIR}/Screenshot_20260901-${n}.png`;

// テーブル領域（ヘッダー・下部操作バーを除外）でゴールドディスクを検出。
function goldBlobs(img:Raster){
  const {width:W,height:H,rgba}=img;
  const x0=Math.round(0.05*W),x1=Math.round(0.95*W),y0=Math.round(0.12*H),y1=Math.round(0.80*H);
  const w=x1-x0,h=y1-y0;
  const mask=new Uint8Array(w*h);
  for(let y=0;y<h;y++)for(let x=0;x<w;x++){
    const s=((y0+y)*W+(x0+x))*4;const R=rgba[s]!,G=rgba[s+1]!,B=rgba[s+2]!;
    // 金: 高R・中高G・低B, かつ赤みが青より強い
    mask[y*w+x]=(R>170&&G>110&&B<120&&R-B>70)?1:0;
  }
  const comps=connectedComponents(mask,w,h,8).filter(c=>c.area>=200);
  // ディスクは丸い（アスペクト~1, 充填率高め, 面積中程度）
  return comps.map(c=>({cx:(x0+c.x+c.w/2)/W, cy:(y0+c.y+c.h/2)/H, w:c.w, h:c.h, area:c.area, aspect:(c.w/c.h).toFixed(2), fill:(c.area/(c.w*c.h)).toFixed(2)}))
    .sort((a,b)=>b.area-a.area);
}

for(const [n,truth] of [['142820','BR'],['142838','BC'],['142903','TL'],['142909','TC'],['142915','TR'],['143026','BL']] as const){
  const img=decodePng(readFileSync(f(n)));
  const blobs=goldBlobs(img);
  console.log(`\n${n} D=${truth}:`);
  for(const b of blobs.slice(0,6)) console.log(`  cx=${b.cx.toFixed(3)} cy=${b.cy.toFixed(3)} ${b.w}x${b.h} area=${b.area} asp=${b.aspect} fill=${b.fill}`);
}
