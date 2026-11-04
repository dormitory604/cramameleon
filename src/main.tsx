import { createRoot } from 'react-dom/client';
import { App } from './ui/App.tsx';
import 'katex/dist/katex.min.css';
import './ui/styles.css';

createRoot(document.getElementById('root')!).render(<App />);
