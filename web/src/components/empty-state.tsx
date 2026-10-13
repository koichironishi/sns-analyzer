import type { ReactNode } from "react";

/**
 * データがないときの表示（MEO と同じ形）。
 * 「何が出るはずか」（title）→「なぜ出ていないか」（body）→「今できること」（action）の順に読ませる。
 */
export function EmptyState({ title, body, action }: { title: string; body?: ReactNode; action?: ReactNode }) {
  return (
    <div className="card empty-state">
      <p className="empty-title">{title}</p>
      {body && <p className="empty-body">{body}</p>}
      {action && <div className="empty-action">{action}</div>}
    </div>
  );
}
