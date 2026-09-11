import { Component, type ReactNode } from 'react';

/**
 * 描画中の例外を受け止め、画面全体が真っ白になるのを防ぐ。
 * 他のメンバーが投稿したデータの形が壊れていても（悪意の有無を問わず）、その部分だけを
 * 代わりの表示に差し替え、残りの画面は使えるままにする。
 * 画面ごと・投稿カードごとに置く。`key` を変えると受け止めた状態をリセットできる。
 */
export class ErrorBoundary extends Component<
  { children?: ReactNode; renderFallback: () => ReactNode },
  { failed: boolean }
> {
  override state = { failed: false };

  static getDerivedStateFromError(): { failed: boolean } {
    return { failed: true };
  }

  override componentDidCatch(error: unknown): void {
    console.error('描画に失敗した部分を代わりの表示にしました', error);
  }

  override render(): ReactNode {
    return this.state.failed ? this.props.renderFallback() : this.props.children;
  }
}
