import { diagnoseConfig } from './config/config-doctor.js';
import { getSyncPaths, loadConfig } from './config/config.js';
import { loadServerManifest } from './core/manifest.js';
import { loadSkillsRegistry } from './core/skills-registry.js';
import { listTrackedServers } from './refresh.js';
import { pathExists } from './utils/utils.js';

export interface DashboardSummary {
  health: {
    issues: number;
  };
  servers: Array<{
    name: string;
    status: 'in-sync' | 'pending' | 'never-synced' | 'error';
    pending: number;
  }>;
  skills: {
    total: number;
    linked: number;
    ignored: number;
  };
  sources: string[];
  agents: Array<{
    name: string;
    exists: boolean;
  }>;
}

export async function loadDashboardSummary(homeDir: string): Promise<DashboardSummary> {
  const config = await loadConfig(homeDir);
  const { skillsDir } = getSyncPaths(homeDir);
  const [report, registry, trackedServers, agents] = await Promise.all([
    diagnoseConfig(config, skillsDir),
    loadSkillsRegistry(homeDir),
    listTrackedServers(homeDir),
    Promise.all(
      Object.entries(config.agents)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(async ([name, path]) => ({ name, exists: await pathExists(path) }))
    )
  ]);

  const linked = Object.values(registry.skills).filter((entry) => entry.status === 'active').length;
  const ignored = Object.values(registry.skills).filter((entry) => entry.status === 'ignored').length;
  const servers = await Promise.all(
    trackedServers.map(async (name) => {
      try {
        const manifest = await loadServerManifest(homeDir, name);
        const skillCount = Object.keys(manifest.skills).length;
        if (skillCount === 0) {
          return {
            name,
            status: 'never-synced',
            pending: 0
          } as const;
        }
        const pending = Object.values(manifest.skills).filter((skill) => skill.status !== 'in-sync').length;
        return {
          name,
          status: pending === 0 ? 'in-sync' : 'pending',
          pending
        } as const;
      } catch {
        return {
          name,
          status: 'error',
          pending: 0
        } as const;
      }
    })
  );

  return {
    health: {
      issues: report.errors.length + report.warnings.length
    },
    servers,
    skills: {
      total: linked + ignored,
      linked,
      ignored
    },
    sources: Object.keys(config.sources).sort(),
    agents
  };
}

export function formatDashboardSummary(summary: DashboardSummary): string {
  const sourceSummary = `${summary.sources.length} (${summary.sources.join(', ')})`;
  const agentSummary = summary.agents
    .map((agent) => `${agent.name} ${agent.exists ? '✓' : '✗'}`)
    .join('  ');
  const serverLines = summary.servers.map((server) => {
    const statusText =
      server.status === 'in-sync'
        ? '✓ in-sync'
        : server.status === 'pending'
          ? `⚠ ${server.pending} skills pending`
          : server.status === 'never-synced'
            ? '? never synced'
            : '✗ error';
    return `  ${server.name.padEnd(8)} ${statusText}`;
  });
  const healthText = summary.health.issues === 0 ? '✓ No issues' : `⚠ ${summary.health.issues} issue(s)`;

  return [
    'Syncskill Status',
    '────────────────────────────────────────',
    '',
    `Skills:   ${summary.skills.total} total (${summary.skills.linked} linked, ${summary.skills.ignored} ignored)`,
    `Sources:  ${sourceSummary}`,
    `Agents:   ${agentSummary}`,
    '',
    'Servers:  (based on cached manifests, no network requests)',
    ...serverLines,
    '',
    `Health:   ${healthText}`,
    '',
    'Quick actions:',
    '  syncskill link          Edit skill-agent mappings',
    '  syncskill update        Update all sources',
    '  syncskill push          Push changes to servers',
    '',
    'Run `syncskill --help` for all commands.'
  ].join('\n');
}
