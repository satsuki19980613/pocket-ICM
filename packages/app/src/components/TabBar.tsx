/** 下段タブバー（モック .tabs 準拠）。Home / ICM / Training / 記録 / 設定。 */
export type TabKey = 'home' | 'icm' | 'training' | 'records' | 'settings';

const TABS: { key: TabKey; label: string; ic: string }[] = [
  { key: 'home', label: 'Home', ic: '⌂' },
  { key: 'icm', label: 'ICM', ic: '♠' },
  { key: 'training', label: 'Training', ic: '◎' },
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
