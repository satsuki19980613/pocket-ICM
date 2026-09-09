import { describe, it, expect } from 'vitest';
import { classifyIssueCode, classifyIssueCodes } from './issueCodes.js';

describe('classifyIssueCode — 既存の実メッセージ文字列を期待コードへ写す', () => {
  it('gate.ts: ストリート unknown', () => {
    expect(classifyIssueCode('ストリート表示が読めませんでした（プリフロップか確認してください）')).toBe(
      'street_unknown',
    );
  });

  it('gate.ts: プリフロップ以外', () => {
    expect(
      classifyIssueCode('プリフロップの画面ではありません（検出: flop）。押し引きはプリフロップのみ対象です'),
    ).toBe('street_not_preflop');
  });

  it('prefill.ts: CHIPS_MODE_ISSUE（チップ表示棄却）', () => {
    expect(
      classifyIssueCode(
        'このスクショはチップ表示です。スタックが BB 表示（例: 20.2 BB）の画面を取り込んでください（チップ表示は手入力をご利用ください）。',
      ),
    ).toBe('display_mode_chips');
  });

  it('spotReconstruction.ts: レイズ（非オールイン）', () => {
    expect(
      classifyIssueCode('SB がレイズ（非オールイン）しています（ミニレイズ/オープン/3bet は push/fold では扱えません）'),
    ).toBe('out_of_scope_raise');
  });

  it('spotReconstruction.ts: リンプ/非オールインへのコール', () => {
    expect(classifyIssueCode('BU がコール（リンプ/非オールインへのコール）しています（push/fold では扱えません）')).toBe(
      'out_of_scope_limp',
    );
  });

  it('spotReconstruction.ts: 未分類のベット', () => {
    expect(classifyIssueCode('CO に未分類のベット 2.30bb があります（要手入力確認）')).toBe(
      'out_of_scope_unclassified_bet',
    );
  });

  it('spotReconstruction.ts: ウォーク', () => {
    expect(classifyIssueCode('hero が BB で pot が未レイズです（ウォーク＝判断が存在しないため対象外）')).toBe(
      'walk',
    );
  });

  it('positionDerivation.ts: D ボタン検出できず', () => {
    expect(classifyIssueCode('D ボタンが検出できていません')).toBe('seat_read_failed');
  });

  it('positionDerivation.ts: D ボタン複数', () => {
    expect(classifyIssueCode('D ボタンが複数席にあります')).toBe('seat_read_failed');
  });

  it('positionDerivation.ts: D ボタン席が empty', () => {
    expect(classifyIssueCode('D ボタン席が empty（不在）です')).toBe('seat_read_failed');
  });

  it('positionDerivation.ts: hero 席数が不正', () => {
    expect(classifyIssueCode('hero 席は 1 つである必要があります（got 2）')).toBe('seat_read_failed');
  });

  it('positionDerivation.ts: 生存席数の範囲外', () => {
    expect(classifyIssueCode('生存席数は 2..6。got 1')).toBe('seat_read_failed');
  });

  it('positionDerivation.ts: 席数（物理リング）の範囲外', () => {
    expect(classifyIssueCode('席数は 2..6。got 7')).toBe('seat_read_failed');
  });

  it('positionDerivation.ts: hero が生存席の中に見つからない', () => {
    expect(classifyIssueCode('hero が生存席の中に見つかりません')).toBe('seat_read_failed');
  });

  it('App.tsx: OVER_SCOPE_MSG（人数上限）', () => {
    expect(classifyIssueCode('現在は6人までの局面に対応しています。')).toBe('too_many_players');
  });

  it('チェックサム不一致（想定文言）', () => {
    expect(classifyIssueCode('ポット・チェックサムが一致しません（Δ=1.20bb）')).toBe('checksum_mismatch');
  });

  it('未知のメッセージは unknown', () => {
    expect(classifyIssueCode('これは分類対象外の文言です')).toBe('unknown');
  });
});

describe('classifyIssueCodes — 複数メッセージ・重複除去・checksum フラグ', () => {
  it('複数メッセージを重複なく出現順で返す', () => {
    const codes = classifyIssueCodes([
      'D ボタンが検出できていません',
      'hero 席は 1 つである必要があります（got 0）',
      '未知のメッセージ',
    ]);
    expect(codes).toEqual(['seat_read_failed', 'unknown']);
  });

  it('空配列は空配列を返す', () => {
    expect(classifyIssueCodes([])).toEqual([]);
  });

  it('checksumOk=false のとき checksum_mismatch を末尾に追加する', () => {
    const codes = classifyIssueCodes([], { checksumOk: false });
    expect(codes).toEqual(['checksum_mismatch']);
  });

  it('checksumOk=false でも二重追加しない（メッセージ側で既に検出済みの場合）', () => {
    const codes = classifyIssueCodes(['ポット・チェックサムが一致しません'], { checksumOk: false });
    expect(codes).toEqual(['checksum_mismatch']);
  });

  it('checksumOk=true では追加しない', () => {
    expect(classifyIssueCodes(['ウォーク'], { checksumOk: true })).toEqual(['walk']);
  });
});
