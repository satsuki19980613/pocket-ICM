/** dev: フレーム → RawReads → runOcrPipeline を end-to-end 実行して表示。 */
import { readFileSync } from 'node:fs';
import { decodePng } from './pngCodec.js';
import { extractRawReads, type ExtractTemplates } from '../src/extract.js';
import { CHIPS_6MAX } from '../src/frameProfile.js';
import { runOcrPipeline } from '../src/pipeline.js';
import type { Template } from '../src/match.js';
import type { Rgba } from '../src/color.js';

const DIR='local-fixtures';
function load(path:string):Template[]{const raw=JSON.parse(readFileSync(path,'utf8')) as any;
  const t=raw.templates; if(Array.isArray(t)) return t.map((g:any)=>({label:g.label,img:{w:g.w,h:g.h,data:Uint8Array.from(g.data)}}));
  return Object.entries(t).map(([label,g]:any)=>({label,img:{w:g.w,h:g.h,data:Uint8Array.from(g.data)}}));}
const templates:ExtractTemplates={digits:load(`${DIR}/digits.json`),ranks:load(`${DIR}/ranks_hero.json`),actions:load(`${DIR}/actions.json`),letters:load(`${DIR}/letters_bb.json`)};

const frame=process.argv[2]??'Screenshot_20260901-142820.png';
const img=decodePng(readFileSync(`${DIR}/${frame}`));
const rgba:Rgba={w:img.width,h:img.height,data:img.rgba};
const reads=extractRawReads(rgba,CHIPS_6MAX,templates,{betMinCh:125});

const f=(r:{value:number;conf:number})=>`${Number.isFinite(r.value)?r.value.toFixed(2):'NaN'}(${r.conf.toFixed(2)})`;
console.log(`=== ${frame} ===`);
console.log(`street=${reads.street.value}(${reads.street.conf.toFixed(2)}) blinds=${f(reads.blinds.sb)}/${f(reads.blinds.bb)} ante=${f(reads.ante.amount)} pot=${f(reads.pot)} hero=${reads.heroHand.value}(${reads.heroHand.conf.toFixed(2)}) mode=${reads.displayMode}`);
for(const s of reads.seats){
  console.log(`  ${s.id} ${s.isHero?'H':' '}${s.isButton?'D':' '} occ=${s.occupancy.value} act=${s.action.value}(${s.action.conf.toFixed(2)}) stack=${f(s.stack)} bet=${f(s.bet)}`);
}
const res=runOcrPipeline(reads);
console.log(`\npipeline ok=${res.ok}`);
if(res.issues.length) console.log('issues:',res.issues.join(' | '));
if(res.state){console.log(`heroPos=${res.state.heroPos} playersLeft=${res.state.playersLeft} blinds=${res.state.blinds.sb}/${res.state.blinds.bb} ante=${res.state.ante.amount}`);
  console.log('seats:',res.state.seats.map(s=>`${s.pos}:${s.state} stk=${s.stack.toFixed(2)} bet=${s.bet}`).join(' '));}
if(res.lowConfidenceFields?.length) console.log('lowConf:',res.lowConfidenceFields.join(','));
