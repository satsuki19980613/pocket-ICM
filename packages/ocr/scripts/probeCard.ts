import { readFileSync } from 'node:fs';
import { decodePng, type Raster } from './pngCodec.js';
const DIR='local-fixtures'; const f=(n:string)=>`${DIR}/Screenshot_20260901-${n}.png`;
function blueFrac(img:Raster, fr:readonly number[], label:string){
  const {width:W,height:H,rgba}=img;
  const x0=Math.round(fr[0]!*W),y0=Math.round(fr[1]!*H),w=Math.round(fr[2]!*W),h=Math.round(fr[3]!*H);
  let any=0,bright=0,n=0;
  for(let y=0;y<h;y++)for(let x=0;x<w;x++){const s=((y0+y)*W+(x0+x))*4;const R=rgba[s]!,G=rgba[s+1]!,B=rgba[s+2]!;n++;
    if(B>R+50&&B>G+30){any++; if(B>150) bright++;}}
  console.log(`${label.padEnd(22)} anyBlue=${(any/n).toFixed(2)} brightBlue=${(bright/n).toFixed(2)}`);
}
const c={TL:[0.235,0.13,0.075,0.085],TC:[0.50,0.09,0.075,0.085],TR:[0.775,0.13,0.075,0.085],BR:[0.835,0.49,0.085,0.085]} as const;
console.log('142820 (TL=folded, TC/TR/BR=active):');
const a=decodePng(readFileSync(f('142820')));
blueFrac(a,c.TL,'TL folded'); blueFrac(a,c.TC,'TC active'); blueFrac(a,c.TR,'TR active'); blueFrac(a,c.BR,'BR active');
console.log('\n142844 (TL/TR/BR=folded, TC active):');
const b=decodePng(readFileSync(f('142844')));
blueFrac(b,c.TL,'TL folded'); blueFrac(b,c.TC,'TC active'); blueFrac(b,c.TR,'TR folded'); blueFrac(b,c.BR,'BR folded');
console.log('\n101510 (TC/BR=empty):');
const e=decodePng(readFileSync(f('101510')));
blueFrac(e,c.TC,'TC empty'); blueFrac(e,c.BR,'BR empty'); blueFrac(e,c.TL,'TL active?');
