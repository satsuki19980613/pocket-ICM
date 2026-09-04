/**
 * エラー画面（3-1d・M3）。求解不能・対象外フレーム・検証失敗の理由を出し、写真経路なら
 * 「別の写真を選ぶ」、常に「手入力する（読めた分を手で埋める）」で入力へ戻す。
 */
export function ErrorView(props: {
  title?: string;
  desc?: string;
  issues: string[];
  /** 手入力モーダルを開く（読めた分を手で埋める）。 */
  onManual: () => void;
  /** 写真経路のときだけ渡す（別の写真を選ぶ → 起点へ）。 */
  onRetry?: () => void;
}): JSX.Element {
  const fromPhoto = !!props.onRetry;
  return (
    <div className="panel err-view">
      <div className="errbanner">
        <div className="et">{props.title ?? 'この内容では計算できません'}</div>
        <div className="ed">
          {props.desc ??
            (fromPhoto
              ? '条件が揃っていません。直して撮り直すか、読めた分を手で埋めてください。'
              : '入力を見直してください。手入力から直せます。')}
        </div>
      </div>

      {props.issues.length > 0 && (
        <>
          <div className="check-h">見つかった問題</div>
          <ul className="check">
            {props.issues.map((m) => (
              <li key={m} className="ng">
                <span className="mark">!</span>
                <div>{m}</div>
              </li>
            ))}
          </ul>
        </>
      )}

      <div className="err-actions">
        {fromPhoto && (
          <button type="button" className="btn" onClick={props.onRetry}>
            別の写真を選ぶ
          </button>
        )}
        <button type="button" className={`btn${fromPhoto ? ' ghost' : ''}`} onClick={props.onManual}>
          {fromPhoto ? '読めた分を手で埋める' : '手入力する'}
        </button>
      </div>
    </div>
  );
}
