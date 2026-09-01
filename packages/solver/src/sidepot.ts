/**
 * サイドポット分配とショーダウン→終局スタック→ICM の計算パス
 * （IMPLEMENTATION_PLAN 1-5 / SPEC §3.3）。
 *
 * ## モデル（SPEC §3.3）
 * push/fold のオールイン・ショーダウンでは、スタック不揃いにより
 * メインポット／サイドポットが生じる。各ポットは「そのポットに拠出した資格者」の
 * 中で着順（タイ込み）に従って分配される。**カバーしている側の余剰チップは
 * やり取りされない**（§3.3-3）。これは下記のレイヤ方式で自然に表現される
 * （最上位レイヤの拠出者が 1 人ならそのレイヤ額は本人に戻る＝未コール分の返却）。
 *
 * ## レイヤ方式
 * commits[i] = プレイヤー i がこのハンドで拠出した総額（ブラインド・アンティ・
 * オールイン分を含む）。フォールド者は拠出額（デッドマネー）を持つが勝てない
 * （eligible=false）。
 *   1. 正の commit の相異なる水準を昇順に並べる。
 *   2. 隣接水準間の各レイヤについて、レイヤ額 = 水準差、拠出者 = その水準以上を
 *      出した全プレイヤー。ポット = レイヤ額 × 拠出者数。
 *   3. レイヤのポットは、拠出者かつ eligible の中で最強（strongerCount 最小）の者が
 *      分け合う（タイは均等割り）。eligible な拠出者が居ないレイヤ（デッドマネーのみ、
 *      通常発生しない）は拠出者に均等返却してチップ保存を保つ。
 *
 * strongerCount は placement.ts と同義（自分より強い手の人数。小さいほど強い、
 * タイは同値）。ショーダウン参加者の部分集合内でも「最小 strongerCount = その集合の
 * 勝者」が成り立つ（全体の全順序が部分集合でも保たれるため）。
 */

import { icmEquities } from './icm.js';
import { decodeSignature, type PlacementDist } from './placement.js';

/**
 * サイドポットを構成して各プレイヤーの獲得チップ（各ポットから受け取る総額。
 * 自分の未コール返却分を含む）を返す。Σwon = Σcommits（チップ保存）。
 *
 * @param commits        各プレイヤーの拠出総額（>=0）。
 * @param eligible       ショーダウンで勝つ資格（フォールド者は false）。
 * @param strongerCount  自分より強い手の人数（小さいほど強い）。eligible な者のみ比較に使う。
 */
export function distributePots(
  commits: readonly number[],
  eligible: readonly boolean[],
  strongerCount: readonly number[],
): number[] {
  const n = commits.length;
  if (eligible.length !== n || strongerCount.length !== n) {
    throw new Error('distributePots: array length mismatch');
  }
  const won = new Array<number>(n).fill(0);

  // 正の相異なる commit 水準を昇順に。
  const levels = Array.from(new Set(commits.filter((c) => c > 0))).sort((a, b) => a - b);

  let prev = 0;
  for (const level of levels) {
    const layerAmount = level - prev;
    prev = level;
    if (layerAmount <= 0) continue;

    // このレイヤの拠出者（commit >= level）。
    const contributors: number[] = [];
    for (let i = 0; i < n; i++) if (commits[i]! >= level) contributors.push(i);
    const potSize = layerAmount * contributors.length;
    if (potSize === 0) continue;

    // 拠出者かつ eligible の中で最強（strongerCount 最小）を勝者に。
    let best = Number.POSITIVE_INFINITY;
    const winners: number[] = [];
    for (const i of contributors) {
      if (!eligible[i]) continue;
      const sc = strongerCount[i]!;
      if (sc < best) {
        best = sc;
        winners.length = 0;
        winners.push(i);
      } else if (sc === best) {
        winners.push(i);
      }
    }

    const share = winners.length > 0 ? potSize / winners.length : potSize / contributors.length;
    const recipients = winners.length > 0 ? winners : contributors;
    for (const i of recipients) won[i]! += share;
  }

  return won;
}

/**
 * ショーダウン 1 結果の終局スタック分布。
 * final[i] = preHandStacks[i] − commits[i] + won[i]。
 *
 * @param preHandStacks ハンド開始時の総スタック（ブラインド・アンティ支払い前）。
 *                      ハンドに関与しない残存プレイヤーも含む全員分。
 * @param commits       各プレイヤーの拠出総額。
 * @param eligible      ショーダウンで勝つ資格。
 * @param strongerCount 自分より強い手の人数（小さいほど強い）。
 */
export function finalStacksFromShowdown(
  preHandStacks: readonly number[],
  commits: readonly number[],
  eligible: readonly boolean[],
  strongerCount: readonly number[],
): number[] {
  const n = preHandStacks.length;
  if (commits.length !== n) throw new Error('finalStacksFromShowdown: length mismatch');
  const won = distributePots(commits, eligible, strongerCount);
  const out = new Array<number>(n);
  for (let i = 0; i < n; i++) out[i] = preHandStacks[i]! - commits[i]! + won[i]!;
  return out;
}

/** 着順分布（placement.ts の signature→確率）と席の対応。 */
export interface ShowdownSetup {
  /** 全席のハンド開始時スタック（拠出前）。長さ N。 */
  preHandStacks: readonly number[];
  /** 全席の拠出総額（ブラインド・アンティ・オールイン分）。長さ N。 */
  commits: readonly number[];
  /**
   * ショーダウン参加者（オールイン者）の席インデックス。
   * この並び順が着順分布 signature の strongerCount ベクトルの順序に一致する。
   */
  participants: readonly number[];
  /** 着順 1..N に対する実払い payout（長さ N = preHandStacks.length）。 */
  payouts: readonly number[];
}

/**
 * ショーダウン→終局スタック分布→ICM の期待値（1-5 の計算パス本体）。
 * 着順分布の各 signature について終局スタックを構成し ICM を適用、確率で重み付き平均する。
 *
 * @param placement 参加者間の着順分布（signature→確率）。signature は
 *                  encodeSignature(strongerCount over participants) と同一エンコード。
 * @returns 全席の期待 ICM equity（実払い pt 建て、入力順）。
 */
export function expectedShowdownIcm(
  setup: ShowdownSetup,
  placement: PlacementDist,
): number[] {
  const { preHandStacks, commits, participants, payouts } = setup;
  const n = preHandStacks.length;
  const k = participants.length;

  const eligible = new Array<boolean>(n).fill(false);
  for (const p of participants) eligible[p] = true;

  const strongerCount = new Array<number>(n).fill(0);
  const equity = new Array<number>(n).fill(0);
  let totalProb = 0;

  for (const [sig, prob] of placement) {
    if (prob === 0) continue;
    const scParts = decodeSignature(sig, k);
    for (let j = 0; j < k; j++) strongerCount[participants[j]!] = scParts[j]!;
    const finalStacks = finalStacksFromShowdown(preHandStacks, commits, eligible, strongerCount);
    const eq = icmEquities(finalStacks, payouts);
    for (let i = 0; i < n; i++) equity[i]! += prob * eq[i]!;
    totalProb += prob;
  }

  // 確率が正規化されていない場合（MC の丸め等）に備えて規格化。
  if (totalProb > 0 && Math.abs(totalProb - 1) > 1e-12) {
    for (let i = 0; i < n; i++) equity[i]! /= totalProb;
  }
  return equity;
}
