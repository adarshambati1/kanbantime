/** Board column configuration — see PLAN.md §1.4. */

export interface ColumnDef {
  id: string;
  label: string;
  kind: 'kanban' | 'timetable';
}

export const DEFAULT_COLUMNS: ColumnDef[] = [
  { id: 'backlog', label: 'Backlog', kind: 'kanban' },
  { id: 'doing', label: 'Doing', kind: 'kanban' },
  { id: 'done', label: 'Done', kind: 'kanban' },
  { id: 'today', label: 'Today', kind: 'timetable' },
];

/** The column a card lands in when its own column no longer exists or was
 *  never set — always the first configured column, never hardcoded. */
export function fallbackColumn(columns: ColumnDef[]): string {
  return columns[0]?.id ?? 'backlog';
}
