/** dev: フレーム → RawReads → runOcrPipeline を end-to-end 実行して表示。 */
import { readFileSync } from 'node:fs';
import { decodePng } from './pngCodec.js';
import { extractRawReads, type ExtractTemplates } from '../src/extract.js';
import { CHIPS_6MAX } from '../src/frameProfile.js';
import { runOcrPipeline } from '../src/pipeline.js';
import { templatesFromJson } from '../src/templates.js';
import type { Rgba } from '../src/color.js';

const DIR='local-fixtures';
// テンプレは **同梱の確定版**（assets/）を読む＝アプリがバンドルするのと同じ物を e2e で検証する。
const A='assets';
const load=(path:string)=>templatesFromJson(JSON.parse(readFileSync(path,'utf8')));
const templates:ExtractTemplates={digits:load(`${A}/digits.json`),ranks:load(`${A}/ranks_hero.json`),actions:load(`${A}/actions.json`),letters:load(`${A}/letters_bb.json`)};

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
