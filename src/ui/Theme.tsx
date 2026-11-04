import { useEffect, useState } from 'react';

export type ThemeChoice = 'system' | 'light' | 'dark';
const KEY = 'cramameleon.theme';
const ORDER: ThemeChoice[] = ['system', 'light', 'dark'];
const LABEL: Record<ThemeChoice, string> = { system: '跟随系统', light: '浅色', dark: '深色' };
const ICON: Record<ThemeChoice, string> = { system: '◐', light: '☀', dark: '☾' };

function readChoice(): ThemeChoice {
  try { const value = localStorage.getItem(KEY); return value === 'light' || value === 'dark' ? value : 'system'; }
  catch { return 'system'; }
}

// 外观偏好只属于当前浏览器，不进入学习会话；index.html 中的内联脚本在首帧前应用同一取值。
export function applyTheme(choice: ThemeChoice) {
  const root = document.documentElement;
  if (choice === 'system') root.removeAttribute('data-theme'); else root.dataset.theme = choice;
  const dark = choice === 'dark' || (choice === 'system' && matchMedia('(prefers-color-scheme: dark)').matches);
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', dark ? '#1b1a18' : '#fffbf5');
}

export function ThemeToggle() {
  const [choice, setChoice] = useState<ThemeChoice>(readChoice);
  useEffect(() => {
    applyTheme(choice);
    try { if (choice === 'system') localStorage.removeItem(KEY); else localStorage.setItem(KEY, choice); } catch { /* 仅本次生效 */ }
    if (choice !== 'system') return;
    const query = matchMedia('(prefers-color-scheme: dark)');
    const onChange = () => applyTheme('system');
    query.addEventListener('change', onChange);
    return () => query.removeEventListener('change', onChange);
  }, [choice]);
  const next = ORDER[(ORDER.indexOf(choice) + 1) % ORDER.length];
  return <button className="icon-button theme-toggle" onClick={() => setChoice(next)}
    aria-label={`外观：${LABEL[choice]}，切换为${LABEL[next]}`} title={`外观：${LABEL[choice]}（点击切换为${LABEL[next]}）`}>{ICON[choice]}</button>;
}
