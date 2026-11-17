import 'katex/dist/katex.min.css';
import remarkMath from 'remark-math';
import rehypeKatex from 'rehype-katex';

export const MATH_REMARK_PLUGIN = remarkMath;
export const MATH_REHYPE_PLUGIN = [
  rehypeKatex,
  {
    throwOnError: false,
    strict: 'ignore',
    errorColor: 'var(--status-danger, #ef4444)'
  }
];
