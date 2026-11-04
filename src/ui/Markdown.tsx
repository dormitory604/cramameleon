import { memo } from 'react';
import ReactMarkdown, { type Components } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import remarkMath from 'remark-math';
import rehypeKatex from 'rehype-katex';

// 模型常输出 \( … \) / \[ … \] 形式的公式，remark-math 只识别 $ / $$，这里在代码块之外做转换。
function normalizeMath(text: string): string {
  return text.split(/(```[\s\S]*?(?:```|$)|`[^`\n]*`)/g).map((part, index) => index % 2 === 1 ? part : part
    .replace(/\\\[([\s\S]+?)\\\]/g, (_, body: string) => `\n$$\n${body.trim()}\n$$\n`)
    .replace(/\\\(([\s\S]+?)\\\)/g, (_, body: string) => `$${body.trim()}$`)).join('');
}

const components: Components = {
  a: ({ node: _node, ...props }) => <a {...props} target="_blank" rel="noreferrer noopener" />,
  table: ({ node: _node, ...props }) => <div className="md-table"><table {...props} /></div>,
};
// 行内场景（如题目选项）不允许段落等块级元素，避免在 button 内产生非法嵌套。
const inlineComponents: Components = { ...components, p: ({ node: _node, ...props }) => <span {...props} /> };
const remarkPlugins = [remarkGfm, remarkMath];
const rehypePlugins: any[] = [[rehypeKatex, { throwOnError: false, strict: false }]];

export const Markdown = memo(function Markdown({ text, inline = false, streaming = false, className = '' }: { text: string; inline?: boolean; streaming?: boolean; className?: string }) {
  const Tag = inline ? 'span' : 'div';
  return <Tag className={`markdown ${inline ? 'inline' : ''} ${streaming ? 'streaming' : ''} ${className}`}>
    <ReactMarkdown remarkPlugins={remarkPlugins} rehypePlugins={rehypePlugins} components={inline ? inlineComponents : components}>{normalizeMath(text)}</ReactMarkdown>
  </Tag>;
});
