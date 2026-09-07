// ブラウザ（App / Phase 3）向け公開エントリ。
// node:fs/os/module に依存する node 版 huTableLoader は含めず、fetch 版
// huTableLoader.browser を使う。HU の既定ローダは登録しない（App は必ず opts.table を渡す）。
// nwaySolver の worker 並列は動的 import で分離済みのため、単一スレッド経路は
// ブラウザで安全にバンドルできる（求解は Web Worker 側で呼ぶ想定）。
export * from './icm.js';
export * from './evaluator.js';
export * from './huEquity.js';
export * from './huTable.js';
export * from './huTableCore.js';
export * from './huTableLoader.browser.js';
export * from './huSolver.js';
export * from './multiwaySolver.js';
export * from './nwaySolver.js';
export * from './showdownJob.js';
export * from './placement.js';
export * from './sidepot.js';
export * from './showdownMc.js';
export * from './showdownExact.js';
export * from './huWinTieLoader.browser.js';
export * from './cardRemoval.js';
export * from './mcConfig.js';
export * from './halfFloat.js';
export * from './pfTable.js';
export * from './pfResult.js';
export * from './pf3wayTable.js';
export * from './nnTable.js';
export * from './nn/mlp.js';
export * from './pfLoader.browser.js';
export * from './pf3wayLoader.browser.js';
export * from './nnLoader.browser.js';
