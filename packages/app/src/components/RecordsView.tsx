import { aggregate, type SpotRecord } from '../records/model';

const ACT_JA: Record<string, string> = { PUSH: 'ALL IN', FOLD: 'FOLD' };

function fmtDate(ms: number): string {
  const d = new Date(ms);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}/${p(d.getMonth() + 1)}/${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

/** 記録（履歴）画面（SPEC §7.3）。一覧・集計・削除・タップで再表示。 */
export function RecordsView(props: {
  records: SpotRecord[];
  onOpen: (rec: SpotRecord) => void;
  onDelete: (id: string) => void;
  onBack: () => void;
}): JSX.Element {
  const { records } = props;
  const stats = aggregate(records);

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
        <div className="panel emptyrec">まだ記録がありません。結果画面の「記録する」で保存できます。</div>
      ) : (
        <div className="reclist">
          {records.map((r) => {
            const wrong = r.evLoss > 0;
            return (
              <div key={r.id} className="recrow">
                <button type="button" className="recmain" onClick={() => props.onOpen(r)}>
                  <span className="rechand">{r.heroHand}</span>
                  <span className="recmeta">
                    {r.heroPos}・{r.playersLeft} left
                  </span>
                  <span className={`recverd ${r.verdict === 'PUSH' ? 'push' : 'fold'}`}>{ACT_JA[r.verdict]}</span>
                  <span className="recact">
                    選択 {ACT_JA[r.heroAction]}
                    {wrong ? <span className="recloss"> −{r.evLoss.toFixed(3)}</span> : <span className="recok"> ✓</span>}
                  </span>
                  <span className="recdate">{fmtDate(r.createdAt)}</span>
                </button>
                <button
                  type="button"
                  className="recdel"
                  aria-label="削除"
                  onClick={() => props.onDelete(r.id)}
                >
                  ✕
                </button>
              </div>
            );
          })}
        </div>
      )}

      <button type="button" className="btn ghost wide" onClick={props.onBack}>
        戻る
      </button>
    </div>
  );
}
