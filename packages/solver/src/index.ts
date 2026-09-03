// Node 向け公開エントリ。node:fs でテーブルを読む huTableLoader を含み、
// HU ソルバーの既定テーブルローダを自動登録する。
// ブラウザ（App）は index.browser.ts を使う（package.json exports の "browser" 条件）。
export * from './icm.js';
export * from './evaluator.js';
export * from './huEquity.js';
export * from './huTable.js';
export * from './huTableCore.js';
export * from './huTableLoader.js';
export * from './huSolver.js';
export * from './multiwaySolver.js';
export * from './nwaySolver.js';
export * from './showdownJob.js';
export * from './placement.js';
export * from './sidepot.js';
export * from './showdownMc.js';
export * from './cardRemoval.js';
export * from './mcConfig.js';
export * from './pfTable.js';
export * from './pf3wayTable.js';

// 依存性注入: Node では HU テーブルの既定ローダを node:fs 版に結線する
// （opts.table を渡さない呼び出し・ハーネスの huSolver ラッパのため）。
import { loadHuTable } from './huTableLoader.js';
import { setDefaultHuTableLoader } from './huSolver.js';
setDefaultHuTableLoader(() => loadHuTable());
