import type { ReactNode } from 'react';

import { useBackLayer } from './BackLayer';

/**
 * 画面上の説明文をたたむための ⓘ マークと、その説明モーダル。
 *
 * 常設の注意書き・ガイド文は初回だけ読めれば十分で、毎回読まされると本文（値・操作）が
 * 埋もれる。見出しの横に `InfoMark` を置き、押したときだけ `InfoModal` で読ませる。
 * 見た目は手入力モーダル（ボトムシート `.modal`）に合わせる。
 */
export function InfoMark(props: { label: string; onClick: () => void }): JSX.Element {
  return (
    <button type="button" className="infomark" aria-label={props.label} onClick={props.onClick}>
      i
    </button>
  );
}

export function InfoModal(props: { title: string; onClose: () => void; children: ReactNode }): JSX.Element {
  // 端末の戻る／Esc で閉じる（最前面のものだけが閉じるよう App の登録簿が面倒を見る）。
  useBackLayer(props.onClose);

  return (
    <div
      className="modal-backdrop"
      onClick={(e) => {
        // 親モーダルの backdrop へバブリングして一緒に閉じるのを防ぐ。
        e.stopPropagation();
        props.onClose();
      }}
      role="presentation"
    >
      <div
        className="modal info-modal"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-label={props.title}
      >
        <div className="modal-head">
          <span className="modal-title">{props.title}</span>
          <button type="button" className="modal-x" aria-label="閉じる" onClick={props.onClose}>
            ✕
          </button>
        </div>
        <div className="modal-body info-body">{props.children}</div>
      </div>
    </div>
  );
}
