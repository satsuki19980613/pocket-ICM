import { readFileSync } from 'node:fs';
import { ncc, type Template } from '../src/match.js';
import { resize } from '../src/raster.js';
const DIR='local-fixtures';
const raw=JSON.parse(readFileSync(`${DIR}/actions.json`,'utf8')) as {templates:Record<string,{w:number;h:number;data:number[]}>};
const T:Template[]=Object.entries(raw.templates).map(([label,g])=>({label,img:{w:g.w,h:g.h,data:Uint8Array.from(g.data)}}));
console.log('pairwise NCC (candidate resized to template size):');
process.stdout.write('           '); for(const t of T) process.stdout.write(t.label.padEnd(11)); console.log();
for(const a of T){process.stdout.write(a.label.padEnd(11));for(const b of T){const cand=a.img.w===b.img.w&&a.img.h===b.img.h?a.img:resize(a.img,b.img.w,b.img.h);process.stdout.write(ncc(cand,b.img).toFixed(2).padEnd(11));}console.log();}
