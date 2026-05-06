import { createPrompt, useState, useKeypress, isEnterKey } from '@inquirer/core';

export interface MatrixEditorConfig {
  title: string;
  rows: string[];
  columns: string[];
  selected: Record<string, string[]>;
  pageSize?: number;
}

export interface MatrixEditorResult {
  cancelled: boolean;
  selected: Record<string, string[]>;
}

export function renderMatrixLine(
  rowName: string,
  columns: string[],
  selectedColumns: string[],
  isActiveRow: boolean,
  activeCol: number,
  rowNameWidth: number,
  colWidth: number
): string {
  const paddedName = rowName.padEnd(rowNameWidth);
  const prefix = isActiveRow ? '→ ' : '  ';

  const cells = columns.map((col, idx) => {
    const isSelected = selectedColumns.includes(col);
    const isActive = isActiveRow && idx === activeCol;
    const check = isSelected ? '✓' : ' ';

    if (isActive) {
      return `[ ${check} ]`.padEnd(colWidth);
    }
    return (isSelected ? '[✓]' : '[ ]').padEnd(colWidth);
  });

  return `${prefix}${paddedName}  ${cells.join('')}`;
}

export const createMatrixEditor = () =>
  createPrompt<MatrixEditorResult, MatrixEditorConfig>((config, done) => {
    const { title, rows, columns, selected: initialSelected, pageSize = 25 } = config;
    const [cursorRow, setCursorRow] = useState(0);
    const [cursorCol, setCursorCol] = useState(0);
    const [currentPage, setCurrentPage] = useState(0);
    const [selected, setSelected] = useState<Record<string, string[]>>(() => {
      const copy: Record<string, string[]> = {};
      for (const key of Object.keys(initialSelected)) {
        copy[key] = [...initialSelected[key]];
      }
      return copy;
    });

    const totalPages = Math.ceil(rows.length / pageSize);
    const pageStart = currentPage * pageSize;
    const pageEnd = Math.min(pageStart + pageSize, rows.length);
    const pageRows = rows.slice(pageStart, pageEnd);

    useKeypress((key) => {
      if (key.name === 'escape') {
        done({ cancelled: true, selected: initialSelected });
        return;
      }

      if (isEnterKey(key)) {
        done({ cancelled: false, selected });
        return;
      }

      if (key.name === 'up') {
        if (cursorRow > 0) {
          setCursorRow(cursorRow - 1);
        } else if (currentPage > 0) {
          setCurrentPage(currentPage - 1);
          setCursorRow(pageSize - 1);
        }
      } else if (key.name === 'down') {
        if (cursorRow < pageRows.length - 1) {
          setCursorRow(cursorRow + 1);
        } else if (currentPage < totalPages - 1) {
          setCurrentPage(currentPage + 1);
          setCursorRow(0);
        }
      } else if (key.name === 'left') {
        setCursorCol(Math.max(0, cursorCol - 1));
      } else if (key.name === 'right') {
        setCursorCol(Math.min(columns.length - 1, cursorCol + 1));
      } else if (key.name === 'space' || key.name === 'tab') {
        const rowName = pageRows[cursorRow];
        const colName = columns[cursorCol];
        const current = selected[rowName] ?? [];
        const updated = current.includes(colName)
          ? current.filter((c) => c !== colName)
          : [...current, colName];
        setSelected({ ...selected, [rowName]: updated });

        if (key.name === 'tab') {
          if (cursorCol < columns.length - 1) {
            setCursorCol(cursorCol + 1);
          } else if (cursorRow < pageRows.length - 1) {
            setCursorCol(0);
            setCursorRow(cursorRow + 1);
          }
        }
      } else if (key.name === 'a') {
        const rowName = pageRows[cursorRow];
        const current = selected[rowName] ?? [];
        const allSelected = columns.every((c) => current.includes(c));
        setSelected({ ...selected, [rowName]: allSelected ? [] : [...columns] });
      } else if (key.name === 'pagedown' || key.name === 'n') {
        if (currentPage < totalPages - 1) {
          setCurrentPage(currentPage + 1);
          setCursorRow(Math.min(cursorRow, Math.min(pageSize, rows.length - (currentPage + 1) * pageSize) - 1));
        }
      } else if (key.name === 'pageup' || key.name === 'p') {
        if (currentPage > 0) {
          setCurrentPage(currentPage - 1);
          setCursorRow(Math.min(cursorRow, pageSize - 1));
        }
      }
    });

    if (rows.length === 0 || columns.length === 0) {
      return `${title}\n\nNo items to display.`;
    }

    const rowNameWidth = Math.max(...rows.map((r) => r.length), 10);
    const colWidth = Math.max(...columns.map((c) => c.length), 5) + 2;

    const headerPadding = ''.padEnd(rowNameWidth + 4);
    const header = `${headerPadding}${columns.map((c) => c.padEnd(colWidth)).join('')}`;
    const separator = '─'.repeat(header.length);

    const pageInfo = totalPages > 1 ? `  Page ${currentPage + 1}/${totalPages}` : '';
    const titleLine = `${title}${pageInfo}`;
    const helpLine = '↑↓←→ navigate  Space: toggle  Tab: next  a: toggle row  Enter: save  Esc: back';

    const lines = pageRows.map((rowName, idx) => {
      const rowSelected = selected[rowName] ?? [];
      return renderMatrixLine(rowName, columns, rowSelected, idx === cursorRow, cursorCol, rowNameWidth, colWidth);
    });

    return `${titleLine}\n${helpLine}\n\n${header}\n${separator}\n${lines.join('\n')}`;
  });
