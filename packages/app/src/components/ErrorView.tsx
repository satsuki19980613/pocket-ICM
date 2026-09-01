/** エラー画面（§7.1）。求解不能・対象外・検証失敗の理由を出して入力へ戻す。 */
export function ErrorView(props: { title?: string; issues: string[]; onBack: () => void }): JSX.Element {
  return (
    <div className="panel err-view">
      <h2 className="scr-h">{props.title ?? '計算できませんでした'}</h2>
      <ul className="issues">
        {props.issues.map((m) => (
          <li key={m}>{m}</li>
        ))}
      </ul>
      <button type="button" className="btn ghost wide" onClick={props.onBack}>
        入力に戻る
      </button>
    </div>
  );
}
