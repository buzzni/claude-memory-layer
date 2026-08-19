import {
  type RuntimeLatencyAggregate,
  type RuntimeResourceReport
} from '../../core/runtime-resource-telemetry.js';

export function formatRuntimeResourceJsonReport(report: RuntimeResourceReport): string {
  return JSON.stringify(report, null, 2);
}

export function formatRuntimeResourceReport(report: RuntimeResourceReport): string {
  const local = report.processLocal;
  const lines = [
    'Runtime resource status',
    `Generated: ${report.generatedAt}`,
    '',
    `This process: ${local.client} ${local.version}`,
    `Model: ${local.model.loaded ? 'loaded' : 'unloaded'} (${local.model.loadedInstances} instance(s))`,
    `Loads: ${local.model.loadCount} (${formatDuration(local.model.lastLoadDurationMs)} last)`,
    `Releases: ${local.model.releaseCount} (${local.model.lastReleaseReason ?? 'none'})`,
    `Cold retrieval: ${formatLatency(local.retrieval.cold)}`,
    `Hot retrieval: ${formatLatency(local.retrieval.hot)}`,
    ''
  ];

  if (!report.observation.supported) {
    lines.push(
      `Process observation: unavailable (${report.observation.reason ?? 'unknown'})`,
      `Platform: ${report.observation.platform}`
    );
    return lines.join('\n');
  }

  lines.push(
    `Observed runtime processes: ${report.observation.processCount}`,
    `Aggregate RSS: ${report.observation.rssMiB} MiB`
  );

  if (report.observation.groups.length === 0) {
    lines.push('Groups: none');
    return lines.join('\n');
  }

  lines.push('', 'Groups:');
  for (const group of report.observation.groups) {
    lines.push(
      `- ${group.client} ${group.version}: ${group.processCount} process(es), ${group.rssMiB} MiB RSS, `
      + `models loaded/unloaded/unavailable ${group.modelLoadedCount}/${group.modelUnloadedCount}/${group.modelStateUnavailableCount}, `
      + `orphans ${group.orphanCount}`
    );
  }
  return lines.join('\n');
}

function formatLatency(aggregate: RuntimeLatencyAggregate): string {
  if (aggregate.count === 0) return 'no samples';
  const average = Math.round((aggregate.totalMs / aggregate.count) * 1000) / 1000;
  return `${aggregate.count} sample(s), ${average} ms average, ${aggregate.failedCount} failed`;
}

function formatDuration(durationMs: number | null): string {
  return durationMs === null ? 'no sample' : `${durationMs} ms`;
}
