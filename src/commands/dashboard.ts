import { homedir } from 'node:os';

import { formatDashboardSummary, loadDashboardSummary } from '../dashboard.js';

export async function runDashboard(homeDir?: string): Promise<void> {
  const resolvedHome = homeDir ?? homedir();
  const summary = await loadDashboardSummary(resolvedHome);
  console.log(formatDashboardSummary(summary));
}
