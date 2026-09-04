/** 下段タブバー（モック .tabs 準拠）。Home / ICM / Drill(soon) / 記録 / 設定。 */
export type TabKey = 'home' | 'icm' | 'drill' | 'records' | 'settings';

const TABS: { key: TabKey; label: string; ic: string; soon?: boolean }[] = [
  { key: 'home', label: 'Home', ic: '⌂' },
  { key: 'icm', label: 'ICM', ic: '♠' },
  { key: 'drill', label: 'Drill', ic: '◎', soon: true },
  { key: 'records', label: '記録', ic: '▤' },
  { key: 'settings', label: '設定', ic: '⚙' },
];

export function TabBar(props: { active: TabKey; onNav: (key: TabKey) => void }): JSX.Element {
  return (
    <nav className="tabs">
      {TABS.map((t) => (
        <button
          key={t.key}
          type="button"
          className={t.soon ? 'soon-tab' : undefined}
          aria-current={props.active === t.key ? 'true' : undefined}
          onClick={() => props.onNav(t.key)}
        >
          <span className="ic">{t.ic}</span>
          {t.label}
        </button>
      ))}
    </nav>
  );
}
