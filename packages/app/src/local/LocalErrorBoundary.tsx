import { Component, type ReactNode } from 'react';

/**
 * ローカル版の画面単位の受け止め役。本体の ErrorBoundary は診断ログ（Supabase）へ送るため、
 * こちらは送信なしの最小版にしている。
 */
export class LocalErrorBoundary extends Component<{ children: ReactNode; onReset: () => void }, { failed: boolean }> {
  override state = { failed: false };

  static getDerivedStateFromError(): { failed: boolean } {
    return { failed: true };
  }

  override componentDidCatch(error: unknown): void {
    console.error(error);
  }

  override render(): ReactNode {
    if (!this.state.failed) return this.props.children;
    return (
      <div className="panel err-view">
        <ul className="issues">
          <li>この画面を表示できませんでした。</li>
        </ul>
        <button type="button" className="btn ghost" onClick={this.props.onReset}>
          ICM に戻る
        </button>
      </div>
    );
  }
}
