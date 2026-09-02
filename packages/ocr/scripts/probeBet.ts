const MINCH=Number(process.argv[2]??125);
import { readFileSync } from 'node:fs';
import { decodePng, type Raster } from './pngCodec.js';
import { recognizeAmount } from '../src/numberField.js';
import { loadTemplates } from './digitsCore.js';
import type { Rgba } from '../src/color.js';
import type { Rect } from '../src/types.js';
const DIR='local-fixtures'; const f=(n:string)=>`${DIR}/Screenshot_20260901-${n}.png`;
const toRgba=(r:Raster):Rgba=>({w:r.width,h:r.height,data:r.rgba});
const px=(r:Raster,fr:readonly number[]):Rect=>({x:Math.round(fr[0]!*r.width),y:Math.round(fr[1]!*r.height),w:Math.round(fr[2]!*r.width),h:Math.round(fr[3]!*r.height)});
const T=loadTemplates(`${DIR}/digits.json`);
const BET:Record<string,readonly number[]>={
  TL:[0.315,0.335,0.075,0.044], TC:[0.487,0.243,0.08,0.044], TR:[0.665,0.335,0.066,0.048],
  BL:[0.303,0.466,0.066,0.05], BC:[0.516,0.592,0.066,0.05], BR:[0.699,0.47,0.062,0.05],
};
// frame: {seat:expected}
const cases:[string,Record<string,number>][]=[
  ['142820',{BC:330,BL:660}], ['142903',{TC:330,TR:660}], ['142909',{TR:330,BR:660}],
  ['143026',{TL:480,TC:960}], ['143020',{BL:400,TL:800}], ['143007',{BR:400,BC:800}],
];
let ok=0,tot=0;
for(const [n,exp] of cases){const img=decodePng(readFileSync(f(n)));const rgba=toRgba(img);
  const line:string[]=[];
  for(const [seat,fr] of Object.entries(BET)){const r=recognizeAmount(rgba,px(img,fr),T,{minCh:MINCH});
    if(seat in exp){tot++;const good=r.value===exp[seat];if(good)ok++;line.push(`${good?'OK':'XX'}${seat}=${r.value}(exp${exp[seat]},c${r.conf.toFixed(2)})`);}
    else if(!Number.isNaN(r.value)&&r.conf>0.5){line.push(`?${seat}=${r.value}(誤検出?c${r.conf.toFixed(2)})`);}
  }
  console.log(`${n}: ${line.join(' ')}`);
}
console.log(`\nbet一致: ${ok}/${tot}`);
