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
    const [searchMode, setSearchMode] = useState(false);
    const [searchQuery, setSearchQuery] = useState('');
    const [selected, setSelected] = useState<Record<string, string[]>>(() => {
      const copy: Record<string, string[]> = {};
      for (const key of Object.keys(initialSelected)) {
        copy[key] = [...initialSelected[key]];
      }
      return copy;
    });

    const filteredRows = searchQuery
      ? rows.filter(row => row.toLowerCase().includes(searchQuery.toLowerCase()))
      : rows;

    const totalPages = Math.ceil(filteredRows.length / pageSize);
    const pageStart = currentPage * pageSize;
    const pageEnd = Math.min(pageStart + pageSize, filteredRows.length);
    const pageRows = filteredRows.slice(pageStart, pageEnd);

    useKeypress((key) => {
      // Cast key to include optional properties that may not be in the type definition
      const keyAny = key as typeof key & { sequence?: string; meta?: boolean };

      // Search mode handling
      if (searchMode) {
        if (key.name === 'escape') {
          setSearchMode(false);
          setSearchQuery('');
          return;
        }
        if (key.name === 'return') {
          setSearchMode(false);
          setCursorRow(0);
          setCurrentPage(0);
          return;
        }
        if (key.name === 'backspace') {
          setSearchQuery(searchQuery.slice(0, -1));
          return;
        }
        if (keyAny.sequence && keyAny.sequence.length === 1 && !key.ctrl && !keyAny.meta) {
          setSearchQuery(searchQuery + keyAny.sequence);
          setCursorRow(0);
          setCurrentPage(0);
          return;
        }
        return;
      }

      // Enter search mode
      if (keyAny.sequence === '/') {
        setSearchMode(true);
        setSearchQuery('');
        return;
      }

      if (key.name === 'escape') {
        done({ cancelled: false, selected });
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
      } else if (key.name === 'a' && !key.shift) {
        // Toggle all columns for current row
        const rowName = pageRows[cursorRow];
        const current = selected[rowName] ?? [];
        const allSelected = columns.every((c) => current.includes(c));
        setSelected({ ...selected, [rowName]: allSelected ? [] : [...columns] });
      } else if (key.name === 'a' && key.shift) {
        // Toggle all rows for current column (Shift+A)
        const colName = columns[cursorCol];
        const allHaveCol = rows.every((r) => (selected[r] ?? []).includes(colName));
        const newSelected: Record<string, string[]> = {};
        for (const row of rows) {
          const current = selected[row] ?? [];
          if (allHaveCol) {
            // Deselect this column from all rows
            newSelected[row] = current.filter((c) => c !== colName);
          } else {
            // Select this column for all rows
            newSelected[row] = current.includes(colName) ? current : [...current, colName];
          }
        }
        setSelected(newSelected);
      } else if (key.name === 'g' && !key.shift) {
        // Jump to first row
        setCurrentPage(0);
        setCursorRow(0);
      } else if (key.name === 'g' && key.shift) {
        // Jump to last row (Shift+G)
        const lastPage = totalPages - 1;
        const rowsOnLastPage = rows.length - lastPage * pageSize;
        setCurrentPage(lastPage);
        setCursorRow(rowsOnLastPage - 1);
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
    const searchIndicator = searchMode ? `  [Search: ${searchQuery}_]` : '';
    const helpLine = searchMode
      ? 'Type to search, Enter to confirm, Esc to cancel'
      : '↑↓←→ navigate  Space: toggle  Tab: next  a: toggle row  A: toggle col  /: search  g/G: first/last  Enter/Esc: save';
    const titleLine = `${title}${searchMode ? searchIndicator : pageInfo}`;

    const lines = pageRows.map((rowName, idx) => {
      const rowSelected = selected[rowName] ?? [];
      return renderMatrixLine(rowName, columns, rowSelected, idx === cursorRow, cursorCol, rowNameWidth, colWidth);
    });

    return `${titleLine}\n${helpLine}\n\n${header}\n${separator}\n${lines.join('\n')}`;
  });
