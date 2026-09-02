import { readFileSync } from 'node:fs';
import { decodePng, type Raster } from './pngCodec.js';
import { detectButtonSeat, type FracPoint } from '../src/button.js';
import type { Rgba } from '../src/color.js';
const DIR='local-fixtures'; const f=(n:string)=>`${DIR}/Screenshot_20260901-${n}.png`;
const toRgba=(r:Raster):Rgba=>({w:r.width,h:r.height,data:r.rgba});
const NAMES=['TL','TC','TR','BL','BC','BR'];
const ANCHORS:FracPoint[]=[{x:0.349,y:0.276},{x:0.569,y:0.266},{x:0.692,y:0.276},{x:0.285,y:0.549},{x:0.603,y:0.623},{x:0.746,y:0.549}];
const truth:Record<string,string>={'142820':'BR','142826':'BR','142838':'BC','142844':'BC','142903':'TL','142909':'TC','142915':'TR','143007':'TR','143020':'BC','143026':'BL','143032':'TL'};
let ok=0,tot=0;
for(const [n,t] of Object.entries(truth)){
  const img=decodePng(readFileSync(f(n)));
  const table={x:Math.round(0.05*img.width),y:Math.round(0.12*img.height),w:Math.round(0.90*img.width),h:Math.round(0.68*img.height)};
  const r=detectButtonSeat(toRgba(img),table,ANCHORS);
  const got=r.value>=0?NAMES[r.value]:'--';
  const good=got===t; if(good)ok++; tot++;
  console.log(`${good?'OK':'XX'} ${n} truth=${t} got=${got} conf=${r.conf.toFixed(2)}`);
}
console.log(`\nD席一致: ${ok}/${tot}`);
