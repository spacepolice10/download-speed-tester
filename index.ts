import type { RequestData } from './types.ts';

const REQUEST_TIMEOUT_MS = 30_000;
const PROGRESS_INTERVAL_MS = 100;

export async function main(args: string[] = process.argv.slice(2)): Promise<RequestData[]> {
  const results: RequestData[] = [];
  process.exitCode = 0;
  if (args.some((arg) => arg === '--help' || arg === '-h')) {
    printHelp();
    return results;
  }

  const address = args[0];
  const requestNumber = Number(args[1] ?? 10);

  if (!address?.trim()) {
    console.error('Usage: npm start -- <address> [requestNumber=10]');
    process.exitCode = 1;
    return results;
  }

  try {
    const url = new URL(address);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error('Unsupported protocol');
  } catch {
    console.error('address must be a valid HTTP or HTTPS URL.');
    process.exitCode = 1;
    return results;
  }

  if (!Number.isSafeInteger(requestNumber) || requestNumber < 1) {
    console.error('requestNumber must be a positive integer.');
    process.exitCode = 1;
    return results;
  }

  for (let request = 1; request <= requestNumber; request++) {
    const onProgress = throttle((progress: Partial<RequestData>) => {
      printProgress(progress, request, requestNumber);
    }, PROGRESS_INTERVAL_MS);
    const result = await downloadRequest(address, request, onProgress);

    results.push(result);
    printRequest(result);
    if (result.error !== undefined) process.exitCode = 1;
  }

  const summary = summarize(results);
  printSummary(summary);
  return results;
}

export async function downloadRequest(
  address: string,
  request: number,
  onProgress: (progress: Partial<RequestData>) => void,
): Promise<RequestData> {
  const startedAtIso = new Date().toISOString();
  const startedAt = performance.now();
  const speedSamples: number[] = [];
  const initial: Partial<RequestData> = {
    request,
    isDownloading: true,
    startedAt: startedAtIso,
    status: null,
    sizeBytes: 0,
    durationMs: 0,
    speedBytesPerSecond: null,
    medianSpeedBytesPerSecond: null,
  };

  let downloadedBytes = 0;
  let lastChunkAt = startedAt;
  let status: number | null = null;
  let error: string | undefined;

  onProgress(initial);
  try {
    const response = await fetch(address, { signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
    status = response.status;

    if (response.body) {
      for await (const chunk of response.body) {
        const chuckStartedAt = performance.now();
        const sampleDurationMs = chuckStartedAt - lastChunkAt;
        downloadedBytes += chunk.byteLength;
        if (sampleDurationMs > 0 && chunk.byteLength > 0) {
          speedSamples.push(calculateSpeed(chunk.byteLength, sampleDurationMs));
        }
        lastChunkAt = chuckStartedAt;

        const durationMs = chuckStartedAt - startedAt;
        const speedBytesPerSecond = calculateSpeed(downloadedBytes, durationMs);
        onProgress({
          ...initial,
          status,
          sizeBytes: downloadedBytes,
          durationMs,
          speedBytesPerSecond,
        });
      }
    }

    if (!response.ok) error = `HTTP ${response.status}`;
  } catch (cause) {
    error = cause instanceof Error ? cause.message : String(cause);
  }

  const endedAt = performance.now();
  const durationMs = endedAt - startedAt;
  const speedBytesPerSecond = status === null ? null : calculateSpeed(downloadedBytes, durationMs);
  const medianSpeedBytesPerSecond = calculateMedianSpeed(speedSamples);

  return {
    request,
    isDownloading: false,
    startedAt: startedAtIso,
    status,
    sizeBytes: downloadedBytes,
    durationMs,
    speedBytesPerSecond,
    medianSpeedBytesPerSecond,
    ...(error !== undefined ? { error } : {}),
  };
}

// helpers

export function throttle<Args extends unknown[]>(callback: (...args: Args) => void, intervalMs: number) {
  let lastCalledAt = -Infinity;

  return (...args: Args): void => {
    const now = performance.now();
    if (now - lastCalledAt < intervalMs) return;

    lastCalledAt = now;
    callback(...args);
  };
}

function summarize(records: RequestData[]) {
  const successful = records.filter((result) => !result.isDownloading && result.error === undefined).length;
  const sizeBytes = records.reduce((total, result) => total + result.sizeBytes, 0);
  const durationMs = records.reduce((total, result) => total + result.durationMs, 0);

  return {
    requests: records.length,
    successful,
    failed: records.length - successful,
    sizeBytes,
    durationMs,
    averageSpeedBytesPerSecond: durationMs > 0 ? sizeBytes * 1000 / durationMs : 0,
  };
}

function clearLine(): void {
  if (!process.stdout.isTTY) return;
  process.stdout.clearLine(0);
  process.stdout.cursorTo(0);
}

function calculateSpeed(sizeBytes: number, durationMs: number): number {
  return durationMs > 0 ? sizeBytes * 1000 / durationMs : 0;
}

function calculateMedianSpeed(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[middle - 1]! + sorted[middle]!) / 2
    : sorted[middle]!;
}

// output

export function printProgress(progress: Partial<RequestData>, request: number, requestNumber: number): void {
  const { speedBytesPerSecond } = progress;
  if (speedBytesPerSecond === undefined) return;
  const speed = speedBytesPerSecond === null
    ? 'calculating speed'
    : `${(speedBytesPerSecond / 1024).toFixed(2)} KiB/s`;
  const text = `Downloading ${progress.request ?? request}/${requestNumber}… ${speed}`;

  if (process.stdout.isTTY) {
    clearLine();
    process.stdout.write(text);
  } else if (speedBytesPerSecond === null) {
    console.log(text);
  }
}

function printRequest(result: RequestData): void {
  clearLine();
  if (result.error !== undefined) {
    console.error(result);
  } else {
    console.log(result);
  }
}

function printSummary(summary: ReturnType<typeof summarize>): void {
  clearLine();
  console.log('Summary:', summary);
}

function printHelp(): void {
  console.log(`Usage:
  npm start -- <address> [requestNumber]
  node index.ts <address> [requestNumber]

Arguments:
  address        HTTP or HTTPS URL to download (required; quote URLs containing &).
  requestNumber  Number of sequential requests; positive integer (default: 10).

Output:
  Live download progress and speed in KiB/s on one terminal line.
  Progress refreshes at most every ${PROGRESS_INTERVAL_MS} ms after the start notice.
  Full result or error after each request, followed by a final summary.
  When piped, prints one start notice per request without live updates.

Options:
  --help, -h     Show this help without making requests.

Measurements:
  Average and median speeds are calculated separately for each request.
  Summary speed = total downloaded bytes / total request duration (including failures).
  Request timeout: ${REQUEST_TIMEOUT_MS / 1000} seconds (fixed in REQUEST_TIMEOUT_MS).

Examples:
  npm start -- "https://samplelib.com/mp4/sample-30s.mp4"
  npm start -- "https://samplelib.com/mp4/sample-30s.mp4" 3
  npm run test:download -- 5
  npm start -- --help`);
}

if (import.meta.main) await main();
