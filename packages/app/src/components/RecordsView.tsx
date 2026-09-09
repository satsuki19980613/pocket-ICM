import { aggregate, type SpotRecord } from '../records/model';

const ACT_JA: Record<string, string> = { PUSH: 'ALL IN', FOLD: 'FOLD' };

function fmtDate(ms: number): string {
  const d = new Date(ms);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}/${p(d.getMonth() + 1)}/${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

/**
 * 記録（履歴）画面（SPEC §5.4）。サーバが正・ローカルはキャッシュ（App.tsx がまずローカル
 * キャッシュを描き、サーバ取得が済み次第差し替える）。一覧の各行は3つの状態を持つ:
 * 計算中（スピナー・タップ不可）/ 完了（自分の選択・EV loss・公開タグ）/ 失敗・中断（理由＋再計算）。
 */
export function RecordsView(props: {
  records: SpotRecord[];
  onOpen: (rec: SpotRecord) => void;
  onDelete: (rec: SpotRecord) => void;
  onRetry: (rec: SpotRecord) => void;
  /** 計算ジョブが進行中か。true の間は「再計算」を無効化する（同時1件の制約）。 */
  jobRunning: boolean;
}): JSX.Element {
  const { records } = props;
  const stats = aggregate(records);

  function del(rec: SpotRecord): void {
    if (!confirm('この記録を削除しますか？（公開中なら公開も取り消されます）')) return;
    props.onDelete(rec);
  }

  return (
    <div className="records-wrap">
      <div className="panel">
        <div className="scr-h">記録</div>
        <div className="statrow">
          <div className="stat">
            <span className="statlbl">記録した場面</span>
            <b className="statval">{stats.count}</b>
          </div>
          <div className="stat">
            <span className="statlbl">EV loss 累計（pt）</span>
            <b className={`statval ${stats.totalEvLoss > 0 ? 'loss' : ''}`}>{stats.totalEvLoss.toFixed(3)}</b>
          </div>
        </div>
      </div>

      {records.length === 0 ? (
        <div className="panel emptyrec">
          まだ記録がありません。ICM タブでスポットを計算すると、ここに自動で記録されます。
        </div>
      ) : (
        <div className="reclist">
          {records.map((r) => {
            if (r.status === 'solving') {
              return (
                <div key={r.id} className="recrow">
                  <div className="recmain recstate">
                    <span className="rechand">{r.heroHand}</span>
                    <span className="recmeta">
                      {r.heroPos}・{r.playersLeft} left
                    </span>
                    <span className="recspin">
                      <span className="spinner sm" aria-hidden="true" />
                      計算中…
                    </span>
                  </div>
                </div>
              );
            }

            if (r.status === 'failed' || r.status === 'aborted') {
              return (
                <div key={r.id} className="recrow">
                  <div className="recmain recstate err">
                    <span className="rechand">{r.heroHand}</span>
                    <span className="recmeta">
                      {r.heroPos}・{r.playersLeft} left
                    </span>
                    <span className="recerrmsg">
                      {r.status === 'aborted'
                        ? '中断されました（アプリを閉じる/リロードで計算が止まりました）'
                        : (r.error ?? '計算に失敗しました')}
                    </span>
                    <div className="recretry-row">
                      <button
                        type="button"
                        className="btn ghost sm recretry"
                        disabled={props.jobRunning}
                        onClick={() => props.onRetry(r)}
                      >
                        再計算
                      </button>
                    </div>
                  </div>
                  <button type="button" className="recdel" aria-label="削除" onClick={() => del(r)}>
                    ✕
                  </button>
                </div>
              );
            }

            // done
            const hasLoss = r.heroAction != null && r.evLoss != null && r.evLoss > 0;
            return (
              <div key={r.id} className="recrow">
                <button type="button" className="recmain" onClick={() => props.onOpen(r)}>
                  <span className="rechand">{r.heroHand}</span>
                  <span className="recmeta">
                    {r.heroPos}・{r.playersLeft} left
                    {r.published && <span className="rectag">公開中</span>}
                  </span>
                  <span className={`recverd ${r.verdict === 'PUSH' ? 'push' : 'fold'}`}>{ACT_JA[r.verdict]}</span>
                  <span className="recact">
                    {r.heroAction == null ? (
                      <span className="recunsel">未選択</span>
                    ) : (
                      <>
                        選択 {ACT_JA[r.heroAction]}
                        {hasLoss ? (
                          <span className="recloss"> −{(r.evLoss ?? 0).toFixed(3)}</span>
                        ) : (
                          <span className="recok"> ✓</span>
                        )}
                      </>
                    )}
                  </span>
                  <span className="recdate">{fmtDate(r.createdAt)}</span>
                </button>
                <button type="button" className="recdel" aria-label="削除" onClick={() => del(r)}>
                  ✕
                </button>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
