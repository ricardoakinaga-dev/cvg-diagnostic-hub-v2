export interface PerfSample {
  status: number;
  durationMs: number;
}

export interface PerfSummary {
  endpoint: string;
  requests: number;
  errors: number;
  errorRate: number;
  p50Ms: number;
  p95Ms: number;
  p99Ms: number;
  maxMs: number;
}

export function summarize(endpoint: string, samples: PerfSample[]): PerfSummary {
  const durations = samples.map((sample) => sample.durationMs).sort((left, right) => left - right);
  const errors = samples.filter((sample) => sample.status < 200 || sample.status >= 300);
  return {
    endpoint,
    requests: samples.length,
    errors: errors.length,
    errorRate: Number((errors.length / Math.max(1, samples.length)).toFixed(4)),
    p50Ms: percentile(durations, 0.5),
    p95Ms: percentile(durations, 0.95),
    p99Ms: percentile(durations, 0.99),
    maxMs: durations.at(-1) ?? 0
  };
}

export function percentile(values: number[], ratio: number): number {
  if (values.length === 0) return 0;
  return values[Math.min(values.length - 1, Math.ceil(values.length * ratio) - 1)];
}

export function round(value: number): number {
  return Number(value.toFixed(2));
}
