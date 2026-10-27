// Loaded the first time a reply has code or math (highlight.js and KaTeX are most of the Markdown's size).
import rehypeHighlight from 'rehype-highlight';
import rehypeKatex from 'rehype-katex';
import remarkMath from 'remark-math';
import 'katex/dist/katex.min.css';

export const remarkExtras = [[remarkMath, { singleDollarTextMath: false }]];
export const rehypeExtras = [
  [rehypeKatex, { throwOnError: false, strict: false }],
  [rehypeHighlight, { detect: false }],
];
