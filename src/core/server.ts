import { getConfiguredServer, loadConfig, type ConfiguredServer } from '../config/config.js';
import { probeServerAccess, type ServerProbeResult } from './transport.js';

export type ProbeLine = ServerProbeResult;

export function formatServerListLines(names: string[]): string[] {
  return [...names].sort();
}

export function formatServerShowLines(server: ConfiguredServer): string[] {
  return [
    `name\t${server.name}`,
    `host\t${server.host}`,
    ...(typeof server.user === 'string' ? [`user\t${server.user}`] : []),
    ...(typeof server.port === 'number' ? [`port\t${server.port}`] : []),
    ...(typeof server.identity_file === 'string' ? [`identity_file\t${server.identity_file}`] : []),
    ...Object.entries(server.remote_agents)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([agent, remotePath]) => `remote_agent\t${agent}\t${remotePath}`)
  ];
}

export function formatProbeLines(results: ProbeLine[]): string[] {
  return results.map((result) => `${result.check}\t${result.ok ? 'ok' : 'fail'}\t${result.detail}`);
}

export async function listServers(homeDir: string): Promise<string[]> {
  return Object.keys((await loadConfig(homeDir)).servers).sort();
}

export async function showServer(homeDir: string, name: string): Promise<ConfiguredServer> {
  return getConfiguredServer(await loadConfig(homeDir), name);
}

export async function probeServer(homeDir: string, name: string): Promise<ProbeLine[]> {
  return probeServerAccess(getConfiguredServer(await loadConfig(homeDir), name));
}
