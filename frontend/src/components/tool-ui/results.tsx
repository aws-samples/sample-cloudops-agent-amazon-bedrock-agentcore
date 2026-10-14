/** Source-owned, reduced Tool UI DataTable/Chart presentation adapters.
 * Based on https://github.com/assistant-ui/tool-ui (MIT; see LICENSE).
 * Native elements replace the upstream React-19-only table context and styling
 * adapters. No sorting/actions/generated components or remote rendering.
 */
import type { Presentation } from '@/services/streamEvents';
import './results.css';

export function DataTable({ rows }: { rows: Record<string, string>[] }) {
  const columns = [...new Set(rows.flatMap((row) => Object.keys(row)))];
  return (
    <div
      className="tool-results-scroll"
      tabIndex={0}
      role="region"
      aria-label="Resource results"
    >
      <table>
        <caption>Resources (up to 50 rows)</caption>
        <thead>
          <tr>
            {columns.map((key) => (
              <th scope="col" key={key}>
                {key.replace(/_/g, ' ')}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, i) => (
            <tr key={i}>
              {columns.map((key) => (
                <td key={key}>{row[key] || '—'}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function Chart({
  unit,
  points,
}: Omit<Extract<Presentation, { kind: 'costs' }>, 'kind'>) {
  const largest = Math.max(...points.map((p) => Math.abs(p.value)), 1);
  return (
    <figure className="tool-cost-chart">
      <figcaption>Unblended cost ({unit})</figcaption>
      <div
        role="img"
        aria-label={`Cost chart in ${unit}; exact values in the following table`}
      >
        {points.map((p, i) => (
          <div key={i} className="tool-cost-row">
            <span>{p.label}</span>
            <span
              className="tool-cost-bar"
              style={{ width: `${(Math.abs(p.value) / largest) * 100}%` }}
            />
            <span>
              {p.value.toLocaleString(undefined, { maximumFractionDigits: 4 })}{' '}
              {unit}
            </span>
          </div>
        ))}
      </div>
      <div
        className="tool-results-scroll"
        tabIndex={0}
        role="region"
        aria-label="Cost values"
      >
        <table>
          <caption>Cost values ({unit})</caption>
          <thead>
            <tr>
              <th scope="col">Period start</th>
              <th scope="col">Unblended cost ({unit})</th>
            </tr>
          </thead>
          <tbody>
            {points.map((p, i) => (
              <tr key={i}>
                <th scope="row">{p.label}</th>
                <td>
                  {p.value} {unit}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </figure>
  );
}
