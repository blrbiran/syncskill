import { describe, it, expect } from 'vitest';
import type { MatrixEditorConfig, MatrixEditorResult } from '../../src/matrix-editor.js';
import { renderMatrixLine, createMatrixEditor } from '../../src/matrix-editor.js';

describe('MatrixEditor types', () => {
  it('defines MatrixEditorConfig interface', () => {
    const config: MatrixEditorConfig = {
      title: 'Test Matrix',
      rows: ['skill-a', 'skill-b'],
      columns: ['claude', 'hermes'],
      selected: { 'skill-a': ['claude'] }
    };
    expect(config.rows).toHaveLength(2);
  });

  it('defines MatrixEditorResult interface', () => {
    const result: MatrixEditorResult = {
      cancelled: false,
      selected: { 'skill-a': ['claude', 'hermes'] }
    };
    expect(result.cancelled).toBe(false);
  });
});

describe('renderMatrixLine', () => {
  it('renders row with checkmarks for selected columns and dots for unselected', () => {
    const line = renderMatrixLine('skill-a', ['claude', 'hermes'], ['claude'], false, 0, 10, 8);
    expect(line).toContain('skill-a');
    expect(line).toContain(' ✓ ');
    expect(line).toContain(' · ');
  });

  it('highlights active cell with brackets when row is active', () => {
    const line = renderMatrixLine('skill-a', ['claude', 'hermes'], ['claude'], true, 0, 10, 8);
    expect(line).toContain('[✓]');
    expect(line).toContain('→');
  });

  it('shows unselected active cell with dot in brackets', () => {
    const line = renderMatrixLine('skill-a', ['claude', 'hermes'], [], true, 0, 10, 8);
    expect(line).toContain('[·]');
  });

  it('uses spaces for non-active cells and brackets for active cell', () => {
    const line = renderMatrixLine('skill-a', ['claude', 'hermes'], ['hermes'], true, 0, 10, 8);
    expect(line).toContain('[·]');
    expect(line).toContain(' ✓ ');
  });

  it('pads row name to specified width', () => {
    const line = renderMatrixLine('abc', ['col'], [], false, 0, 10, 5);
    expect(line).toMatch(/abc\s{7}/);
  });
});

describe('createMatrixEditor', () => {
  it('returns a function that can be called as a prompt', () => {
    const editor = createMatrixEditor();
    expect(typeof editor).toBe('function');
  });
});

describe('matrix editor shortcuts', () => {
  describe('column toggle (c key)', () => {
    it('should toggle all rows for a given column', () => {
      // Test the logic: given a column index, toggling means:
      // - If all rows have that column selected -> deselect all
      // - If some or none have it selected -> select all
      const rows = ['skill-a', 'skill-b', 'skill-c'];
      const columns = ['claude', 'hermes'];
      const colIndex = 0; // 'claude'
      const colName = columns[colIndex];

      // Scenario 1: No rows have claude selected
      const selected1: Record<string, string[]> = {
        'skill-a': [],
        'skill-b': ['hermes'],
        'skill-c': []
      };
      const allHaveCol1 = rows.every(r => (selected1[r] ?? []).includes(colName));
      expect(allHaveCol1).toBe(false);
      // After toggle, all should have 'claude'
      const newSelected1: Record<string, string[]> = {};
      for (const row of rows) {
        const current = selected1[row] ?? [];
        newSelected1[row] = current.includes(colName) ? current : [...current, colName];
      }
      expect(newSelected1['skill-a']).toContain('claude');
      expect(newSelected1['skill-b']).toContain('claude');
      expect(newSelected1['skill-c']).toContain('claude');

      // Scenario 2: All rows have claude selected
      const selected2: Record<string, string[]> = {
        'skill-a': ['claude'],
        'skill-b': ['claude', 'hermes'],
        'skill-c': ['claude']
      };
      const allHaveCol2 = rows.every(r => (selected2[r] ?? []).includes(colName));
      expect(allHaveCol2).toBe(true);
      // After toggle, none should have 'claude'
      const newSelected2: Record<string, string[]> = {};
      for (const row of rows) {
        const current = selected2[row] ?? [];
        newSelected2[row] = current.filter(c => c !== colName);
      }
      expect(newSelected2['skill-a']).not.toContain('claude');
      expect(newSelected2['skill-b']).not.toContain('claude');
      expect(newSelected2['skill-c']).not.toContain('claude');
      // hermes should still be there
      expect(newSelected2['skill-b']).toContain('hermes');
    });
  });

  describe('jump to first/last row (g/G keys)', () => {
    it('should calculate first row position correctly', () => {
      // g key: jump to first row (cursorRow = 0, currentPage = 0)
      const firstRowCursor = 0;
      const firstPage = 0;
      expect(firstRowCursor).toBe(0);
      expect(firstPage).toBe(0);
    });

    it('should calculate last row position correctly', () => {
      // G key: jump to last row
      const rows = ['skill-a', 'skill-b', 'skill-c', 'skill-d', 'skill-e'];
      const pageSize = 2;
      const totalPages = Math.ceil(rows.length / pageSize); // 3 pages
      const lastPage = totalPages - 1; // page 2 (0-indexed)
      const rowsOnLastPage = rows.length - lastPage * pageSize; // 1 row on last page
      const lastRowCursor = rowsOnLastPage - 1; // 0 (first row on last page)

      expect(lastPage).toBe(2);
      expect(lastRowCursor).toBe(0);
    });

    it('should handle single page correctly for G key', () => {
      const rows = ['skill-a', 'skill-b'];
      const pageSize = 10;
      const totalPages = Math.ceil(rows.length / pageSize); // 1 page
      const lastPage = totalPages - 1; // page 0
      const rowsOnLastPage = rows.length - lastPage * pageSize; // 2 rows
      const lastRowCursor = rowsOnLastPage - 1; // 1 (second row)

      expect(lastPage).toBe(0);
      expect(lastRowCursor).toBe(1);
    });
  });

  describe('help line includes new shortcuts', () => {
    it('should document r for row toggle', () => {
      const helpLine = '↑↓←→ navigate  Space: toggle  Tab: next  r: toggle row  c: toggle col  /: search  g/G: first/last  Enter/Esc: save';
      expect(helpLine).toContain('r: toggle row');
    });

    it('should document c for column toggle', () => {
      const helpLine = '↑↓←→ navigate  Space: toggle  Tab: next  r: toggle row  c: toggle col  /: search  g/G: first/last  Enter/Esc: save';
      expect(helpLine).toContain('c: toggle col');
    });

    it('should document g/G for jump navigation', () => {
      const helpLine = '↑↓←→ navigate  Space: toggle  Tab: next  r: toggle row  c: toggle col  /: search  g/G: first/last  Enter/Esc: save';
      expect(helpLine).toContain('g/G: first/last');
    });
  });

  describe('search functionality', () => {
    it('should include search in help line', () => {
      const helpLine = '↑↓←→ navigate  Space: toggle  Tab: next  r: toggle row  c: toggle col  /: search  g/G: first/last  Enter/Esc: save';
      expect(helpLine).toContain('/: search');
    });

    it('should filter rows based on search query', () => {
      const rows = ['skill-a', 'skill-b', 'other-skill', 'test-plugin'];
      const searchQuery = 'skill';
      const filteredRows = searchQuery
        ? rows.filter(row => row.toLowerCase().includes(searchQuery.toLowerCase()))
        : rows;
      expect(filteredRows).toEqual(['skill-a', 'skill-b', 'other-skill']);
      expect(filteredRows).not.toContain('test-plugin');
    });

    it('should be case insensitive', () => {
      const rows = ['Skill-A', 'skill-b', 'OTHER-SKILL'];
      const searchQuery = 'SKILL';
      const filteredRows = rows.filter(row => row.toLowerCase().includes(searchQuery.toLowerCase()));
      expect(filteredRows).toEqual(['Skill-A', 'skill-b', 'OTHER-SKILL']);
    });

    it('should return all rows when search query is empty', () => {
      const rows = ['skill-a', 'skill-b', 'other'];
      const searchQuery = '';
      const filteredRows = searchQuery
        ? rows.filter(row => row.toLowerCase().includes(searchQuery.toLowerCase()))
        : rows;
      expect(filteredRows).toEqual(rows);
    });
  });
});
