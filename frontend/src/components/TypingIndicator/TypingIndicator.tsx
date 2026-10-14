import type { TypingIndicatorProps } from '@/types';
import styles from './TypingIndicator.module.css';

export function TypingIndicator({ progressMessage }: TypingIndicatorProps) {
  const ariaLabel = progressMessage || 'Agent is working...';

  return (
    <div
      className={styles.container}
      role="status"
      aria-label={ariaLabel}
    >
      <div className={styles.bubble}>
        <span className={styles.workingText}>{ariaLabel}<span className={styles.ellipsis} /></span>
      </div>
    </div>
  );
}
