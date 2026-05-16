import { diagnoseConfig } from './config/config-doctor.js';
import { getSyncPaths, loadConfig } from './config/config.js';
import { loadSkillsRegistry } from './core/skills-registry.js';
import { listTrackedServers } from './refresh.js';

export interface DashboardSummary {
  health: {
    issues: number;
  };
  servers: {
    local: number;
  };
  skills: {
    active: number;
    ignored: number;
  };
}

export async function loadDashboardSummary(homeDir: string): Promise<DashboardSummary> {
  const config = await loadConfig(homeDir);
  const { skillsDir } = getSyncPaths(homeDir);
  const report = await diagnoseConfig(config, skillsDir);
  const registry = await loadSkillsRegistry(homeDir);
  const servers = await listTrackedServers(homeDir);

  const active = Object.values(registry.skills).filter((entry) => entry.status === 'active').length;
  const ignored = Object.values(registry.skills).filter((entry) => entry.status === 'ignored').length;

  return {
    health: {
      issues: report.errors.length + report.warnings.length
    },
    servers: {
      local: servers.length
    },
    skills: {
      active,
      ignored
    }
  };
}

export function formatDashboardSummary(summary: DashboardSummary): string {
  return [
    'Health',
    `  ${summary.health.issues} issues`,
    'Servers',
    `  ${summary.servers.local} local`,
    'Skills',
    `  ${summary.skills.active} active`,
    `  ${summary.skills.ignored} ignored`
  ].join('\n');
}
