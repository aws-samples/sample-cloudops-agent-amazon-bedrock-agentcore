// Adapted from assistant-ui/tool-ui DataTable/Chart (MIT). See NOTICE.md.
// Read-only, React 18-compatible presentation using the assistant-ui token system.
import { parsePresentation } from './schema';
import styles from './ToolResult.module.css';

export function ToolResult({ value }: { value: unknown }) {
  const result = parsePresentation(value);
  if (!result) return <p className={styles.fallback}>Result received. Details are included in the answer.</p>;

  if (result.kind === 'table') {
    return (
      <div className={styles.overflow} tabIndex={0} role="region" aria-label={`${result.title} table`}>
        <table className={styles.table} aria-label={result.title} data-tool-ui-id={result.id}>
          <caption>{result.title}</caption>
          <thead><tr>{result.columns.map(column => <th key={column.key} scope="col">{column.label}</th>)}</tr></thead>
          <tbody>{result.data.map((row, index) => (
            <tr key={index}>{result.columns.map(column => <td key={column.key}>{String(row[column.key] ?? '—')}</td>)}</tr>
          ))}</tbody>
        </table>
        {result.data.length === 0 && <p className={styles.fallback}>{result.emptyMessage ?? 'No resources returned.'}</p>}
      </div>
    );
  }

  const maximum = Math.max(...result.data.map(row => Math.abs(row.amount)), 1);
  return (
    <figure className={styles.chart} data-tool-ui-id={result.id} aria-label={result.title}>
      <figcaption>{result.title} ({result.unit})</figcaption>
      <div aria-hidden="true" className={styles.bars}>
        {result.data.map((row, index) => (
          <div className={styles.barRow} key={index}>
            <span>{row.label}</span>
            <div className={styles.track}><div className={styles.bar} style={{ width: `${Math.abs(row.amount) / maximum * 100}%` }} /></div>
            <span>{row.amount.toLocaleString(undefined, { maximumFractionDigits: 2 })}</span>
          </div>
        ))}
      </div>
      <details>
        <summary>View chart data</summary>
        <table className={styles.table} aria-label={`${result.title} data`}>
          <thead><tr><th scope="col">Period / service</th><th scope="col">Cost ({result.unit})</th></tr></thead>
          <tbody>{result.data.map((row, index) => <tr key={index}><th scope="row">{row.label}</th><td>{row.amount}</td></tr>)}</tbody>
        </table>
      </details>
    </figure>
  );
}
