// purge-images の「総量上限を超えたとき、どのスクショを消すか」の判断（純関数・Vitest でテスト）。

export interface EvictionCandidate {
  readonly id: string;
  readonly owner: string;
  /** Storage が記録した実物の大きさ（バイト）。 */
  readonly size: number;
  /** Storage が記録した作成時刻（ISO）。古い順に消すのに使う。 */
  readonly createdAt: string;
  readonly protected: boolean;
}

/**
 * 総量が上限を超えたときに消す非保護ファイルの id を選ぶ。
 *
 * - 上限以内なら何も消さない。
 * - 保護ファイル（OCR が読めなかった画像）だけで上限以上なら何も消さない（警告だけにする）。
 * - 消すのは「公平な取り分（上限 ÷ ファイルを持つ人数）」を超えて使っている人の分だけ。
 *   使用量のいちばん多い人の古い非保護ファイルから順に消す。取り分以内の人のファイルは消さない。
 *   以前は全員の古い順に消していたため、1人が大量に上げる（保護にする）と、他の人のスクショが
 *   まとめて消えてしまった（セキュリティレビューで発見）。
 */
export function planEviction(items: readonly EvictionCandidate[], limitBytes: number): string[] {
  const total = items.reduce((s, it) => s + it.size, 0);
  if (total <= limitBytes) return [];
  const protectedBytes = items.filter((it) => it.protected).reduce((s, it) => s + it.size, 0);
  if (protectedBytes >= limitBytes) return [];

  const byOwner = new Map<string, { total: number; queue: EvictionCandidate[] }>();
  for (const it of items) {
    const e = byOwner.get(it.owner) ?? { total: 0, queue: [] };
    e.total += it.size;
    if (!it.protected) e.queue.push(it);
    byOwner.set(it.owner, e);
  }
  for (const e of byOwner.values()) e.queue.sort((a, b) => a.createdAt.localeCompare(b.createdAt));

  const fair = limitBytes / byOwner.size;
  const out: string[] = [];
  let projected = total;
  while (projected > limitBytes) {
    let pick: { total: number; queue: EvictionCandidate[] } | null = null;
    for (const e of byOwner.values()) {
      if (e.total > fair && e.queue.length > 0 && (!pick || e.total > pick.total)) pick = e;
    }
    if (!pick) break;
    const victim = pick.queue.shift();
    if (!victim) break;
    out.push(victim.id);
    pick.total -= victim.size;
    projected -= victim.size;
  }
  return out;
}
