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
  it('renders row with checkmarks for selected columns', () => {
    const line = renderMatrixLine('skill-a', ['claude', 'hermes'], ['claude'], false, 0, 10, 8);
    expect(line).toContain('skill-a');
    expect(line).toContain('[✓]');
    expect(line).toContain('[ ]');
  });

  it('highlights active cell when row is active', () => {
    const line = renderMatrixLine('skill-a', ['claude', 'hermes'], ['claude'], true, 0, 10, 8);
    expect(line).toContain('[ ✓ ]');
    expect(line).toContain('→');
  });

  it('shows unselected active cell with spaces', () => {
    const line = renderMatrixLine('skill-a', ['claude', 'hermes'], [], true, 0, 10, 8);
    expect(line).toContain('[   ]');
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
