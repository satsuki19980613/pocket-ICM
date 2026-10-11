/** スポット組み立て用: 席がプリフロップに置いているブラインド額（SB/BB 以外は 0）。 */
export function blindBet(pos: string, sb: number, bb: number): number {
  if (pos === 'SB') return sb;
  if (pos === 'BB') return bb;
  return 0;
}
