import { useEffect, useState } from 'react';

export type ThemeChoice = 'light' | 'dark';
const KEY = 'cramameleon.theme';
const LABEL: Record<ThemeChoice, string> = { light: '浅色', dark: '深色' };
const ICON: Record<ThemeChoice, string> = { light: '☀', dark: '☾' };

function readChoice(): ThemeChoice {
  try { return localStorage.getItem(KEY) === 'dark' ? 'dark' : 'light'; }
  catch { return 'light'; }
}

// 外观偏好只属于当前浏览器，不进入学习会话；theme-init.js 在首帧前应用同一取值。
export function applyTheme(choice: ThemeChoice) {
  document.documentElement.dataset.theme = choice;
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', choice === 'dark' ? '#1b1a18' : '#fffbf5');
}

export function ThemeToggle() {
  const [choice, setChoice] = useState<ThemeChoice>(readChoice);
  useEffect(() => {
    applyTheme(choice);
    try { localStorage.setItem(KEY, choice); } catch { /* 仅本次生效 */ }
  }, [choice]);
  const next = choice === 'light' ? 'dark' : 'light';
  return <button className="icon-button theme-toggle" onClick={() => setChoice(next)}
    aria-label={`切换为${LABEL[next]}模式`} title={`当前为${LABEL[choice]}模式，点击切换为${LABEL[next]}模式`}>
    <span aria-hidden="true">{ICON[choice]}</span>{LABEL[choice]}
  </button>;
}
