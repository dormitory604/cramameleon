import { memo, useId, useMemo } from 'react';
import MarkdownIt from 'markdown-it';
import { footnote } from '@mdit/plugin-footnote';
import { katex } from '@mdit/plugin-katex';
import { tasklist } from '@mdit/plugin-tasklist';

const markdown = MarkdownIt({ html: false, linkify: true })
  .use(katex, { delimiters: 'all', throwOnError: false, logger: () => 'ignore' as const, trust: false })
  .use(footnote)
  .use(tasklist, { containerClass: 'contains-task-list' });

// 历史里的题板记录是本机附注；模型偶尔会把它原样抄进回答（JSON 转义后公式也会坏掉），展示时去掉。
export function stripQuizRecords(text: string): string {
  return text
    .replace(/(?:〔系统附注[^〕]*〕\s*)?题目记录[：:]\s*\{[\s\S]*?\}\s*用户作答[：:][^\n]*/g, '')
    .replace(/(?:〔系统附注[^〕]*〕\s*)?题目记录[：:]\s*\{[^\n]*/g, '')
    .replace(/〔系统附注[^〕]*〕/g, '')
    .trimEnd();
}

markdown.renderer.rules.link_open = (tokens, index, options, env, renderer) => {
  if (env?.inline) return '';
  tokens[index].attrSet('target', '_blank');
  tokens[index].attrSet('rel', 'noopener noreferrer');
  return renderer.renderToken(tokens, index, options);
};
markdown.renderer.rules.link_close = (tokens, index, options, env, renderer) =>
  env?.inline ? '' : renderer.renderToken(tokens, index, options);
const renderFootnoteRef = markdown.renderer.rules.footnote_ref!;
markdown.renderer.rules.footnote_ref = (tokens, index, options, env, renderer) =>
  env?.inline ? '' : renderFootnoteRef(tokens, index, options, env, renderer);
markdown.renderer.rules.table_open = (tokens, index, options, _env, renderer) =>
  '<div class="md-table">' + renderer.renderToken(tokens, index, options);
markdown.renderer.rules.table_close = (tokens, index, options, _env, renderer) =>
  renderer.renderToken(tokens, index, options) + '</div>';

export const Markdown = memo(function Markdown({ text, inline = false, streaming = false, className = '' }: { text: string; inline?: boolean; streaming?: boolean; className?: string }) {
  const docId = useId();
  // Quiz markup lives inside headings, paragraphs and buttons. Render only phrasing content there.
  const markup = useMemo(() => ({
    __html: inline ? markdown.renderInline(text, { inline }) : markdown.render(text, { docId }),
  }), [text, inline, docId]);
  const Tag = inline ? 'span' : 'div';
  return <Tag className={`markdown ${inline ? 'inline' : ''} ${streaming ? 'streaming' : ''} ${className}`}
    dangerouslySetInnerHTML={markup} />;
});
