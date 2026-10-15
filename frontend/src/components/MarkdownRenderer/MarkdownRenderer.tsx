import { useMemo } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import rehypeSanitize from 'rehype-sanitize';
import type { Components } from 'react-markdown';
import { CodeBlock } from '@/components/MarkdownRenderer/CodeBlock';
import styles from './MarkdownRenderer.module.css';

interface MarkdownRendererProps {
  content: string;
}

export function MarkdownRenderer({ content }: MarkdownRendererProps) {
  const components: Components = useMemo(
    () => ({
      a: ({ href, children, ...props }) => (
        <a
          href={href}
          target="_blank"
          rel="noopener noreferrer"
          className={styles.link}
          {...props}
        >
          {children}
        </a>
      ),
      code: ({ className, children, ...props }) => {
        // Fenced blocks carry a language class; keep raw text intact for display/copy.
        const match = /language-(\w+)/.exec(className || '');
        const isInline = !match && !className;

        if (isInline) {
          return (
            <code className={styles.inlineCode} {...props}>
              {children}
            </code>
          );
        }

        // Fenced code block — render via CodeBlock component
        const codeString = String(children).replace(/\n$/, '');
        return <CodeBlock code={codeString} language={match?.[1]} />;
      },
      pre: ({ children }) => <>{children}</>,
      table: ({ children, ...props }) => (
        <div className={styles.tableWrapper}>
          <table className={styles.table} {...props}>
            {children}
          </table>
        </div>
      ),
      h1: ({ children, ...props }) => (
        <h1 className={styles.h1} {...props}>{children}</h1>
      ),
      h2: ({ children, ...props }) => (
        <h2 className={styles.h2} {...props}>{children}</h2>
      ),
      h3: ({ children, ...props }) => (
        <h3 className={styles.h3} {...props}>{children}</h3>
      ),
      h4: ({ children, ...props }) => (
        <h4 className={styles.h4} {...props}>{children}</h4>
      ),
      h5: ({ children, ...props }) => (
        <h5 className={styles.h5} {...props}>{children}</h5>
      ),
      h6: ({ children, ...props }) => (
        <h6 className={styles.h6} {...props}>{children}</h6>
      ),
      ul: ({ children, ...props }) => (
        <ul className={styles.list} {...props}>{children}</ul>
      ),
      ol: ({ children, ...props }) => (
        <ol className={styles.list} {...props}>{children}</ol>
      ),
    }),
    []
  );

  // If content is empty, render nothing
  if (!content || content.trim().length === 0) {
    return <div className={styles.container} />;
  }

  try {
    return (
      <div className={styles.container}>
        <ReactMarkdown
          remarkPlugins={[remarkGfm]}
          rehypePlugins={[rehypeSanitize]}
          components={components}
        >
          {content}
        </ReactMarkdown>
      </div>
    );
  } catch {
    // Fallback: render as plain text if markdown parsing throws
    return (
      <div className={styles.container}>
        <p className={styles.fallback}>{content}</p>
      </div>
    );
  }
}
