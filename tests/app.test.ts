import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { test, type TestContext } from 'node:test';
import { downloadRequest, main, printProgress, throttle } from '../index.ts';
import type { RequestData } from '../types.ts';

const ADDRESS = 'https://example.test/video.mp4';

function setup(t: TestContext, tty = false) {
  let clock = 0;
  let respond: typeof fetch = async () => new Response('hello');
  const calls: Parameters<typeof fetch>[] = [];
  const logs: unknown[][] = [];
  const errors: unknown[][] = [];
  const writes: string[] = [];
  const terminalEvents: string[] = [];
  const previousExitCode = process.exitCode;
  const terminalProperties = ['isTTY', 'clearLine', 'cursorTo'] as const;
  const descriptors = terminalProperties.map((key) => Object.getOwnPropertyDescriptor(process.stdout, key));

  process.exitCode = undefined;
  t.mock.method(performance, 'now', () => clock);
  t.mock.method(globalThis, 'fetch', async (...args: Parameters<typeof fetch>) => {
    calls.push(args);
    return respond(...args);
  });
  t.mock.method(console, 'log', (...args: unknown[]) => logs.push(structuredClone(args)));
  t.mock.method(console, 'error', (...args: unknown[]) => errors.push(structuredClone(args)));
  Object.defineProperties(process.stdout, {
    isTTY: { configurable: true, value: tty },
    clearLine: { configurable: true, value: () => { terminalEvents.push('clear'); return true; } },
    cursorTo: { configurable: true, value: () => { terminalEvents.push('cursor'); return true; } },
  });
  t.mock.method(process.stdout, 'write', (chunk: string | Uint8Array) => {
    writes.push(String(chunk));
    return true;
  });

  t.after(() => {
    t.mock.restoreAll();
    terminalProperties.forEach((key, index) => {
      const descriptor = descriptors[index];
      if (descriptor) Object.defineProperty(process.stdout, key, descriptor);
      else Reflect.deleteProperty(process.stdout, key);
    });
    process.exitCode = previousExitCode;
  });

  return {
    calls, logs, errors, writes, terminalEvents,
    advance(ms: number) { clock += ms; },
    respondWith(handler: typeof fetch) { respond = handler; },
    summary() {
      const summaries = logs.filter(([label]) => label === 'Summary:');
      assert.equal(summaries.length, 1, 'Print exactly one final summary');
      return summaries[0]![1];
    },
  };
}

type Harness = ReturnType<typeof setup>;
type Chunk = { bytes: number; afterMs: number };

function download(
  h: Harness,
  chunks: Chunk[],
  options: { status?: number; endDelayMs?: number; error?: Error; onEnd?: () => void } = {},
): Response {
  let index = 0;
  return new Response(new ReadableStream<Uint8Array>({
    pull(controller) {
      const chunk = chunks[index++];
      if (chunk) {
        h.advance(chunk.afterMs);
        controller.enqueue(new Uint8Array(chunk.bytes));
      } else {
        h.advance(options.endDelayMs ?? 0);
        options.onEnd?.();
        if (options.error) controller.error(options.error);
        else controller.close();
      }
    },
  }, { highWaterMark: 0 }), { status: options.status ?? 200 });
}

test('importing the app does not start downloads', () => {
  const script = `globalThis.fetch = () => { throw new Error('Unexpected fetch'); }; await import('./index.ts');`;
  const run = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
    cwd: new URL('..', import.meta.url), encoding: 'utf8', timeout: 5000,
  });
  assert.equal(run.status, 0, run.stderr);
  assert.equal(run.stdout, '');
  assert.equal(run.stderr, '');
});

test('speed printer accepts partial updates and ignores unrelated or empty updates', (t) => {
  const h = setup(t, true);
  printProgress({}, 1, 3);
  printProgress({ sizeBytes: 1024 }, 1, 3);
  printProgress({ status: 200, durationMs: 100 }, 1, 3);
  assert.equal(h.writes.length, 0);

  printProgress({ speedBytesPerSecond: null }, 1, 3);
  printProgress({ speedBytesPerSecond: 1024 }, 1, 3);
  printProgress({ request: 2, speedBytesPerSecond: 2048 }, 1, 3);
  assert.deepEqual(h.writes, [
    'Downloading 1/3… calculating speed',
    'Downloading 1/3… 1.00 KiB/s',
    'Downloading 2/3… 2.00 KiB/s',
  ]);
});

test('progress receives independent full request snapshots from startup through each chunk', async (t) => {
  const h = setup(t);
  const progress: Partial<RequestData>[] = [];
  h.respondWith(async () => download(h, [
    { bytes: 100, afterMs: 100 },
    { bytes: 300, afterMs: 100 },
  ]));
  const result = await downloadRequest(ADDRESS, 7, (snapshot) => progress.push(snapshot));

  assert.equal(progress.length, 3);
  assert.deepEqual(progress.map((snapshot) => snapshot.request), [7, 7, 7]);
  assert.deepEqual(progress.map((snapshot) => snapshot.status), [null, 200, 200]);
  assert.deepEqual(progress.map((snapshot) => snapshot.sizeBytes), [0, 100, 400]);
  assert.deepEqual(progress.map((snapshot) => snapshot.durationMs), [0, 100, 200]);
  assert.deepEqual(progress.map((snapshot) => snapshot.speedBytesPerSecond), [null, 1000, 2000]);
  assert.ok(progress.every((snapshot) => snapshot.isDownloading === true));
  assert.ok(progress.every((snapshot) => snapshot.startedAt === result.startedAt));
  assert.ok(progress.every((snapshot) => snapshot.medianSpeedBytesPerSecond === null));
  assert.ok(progress.every((snapshot) => !('error' in snapshot)));
  assert.equal(new Set(progress).size, 3);
  assert.equal(result.isDownloading, false);
  assert.equal(result.error, undefined);
  assert.equal(result.medianSpeedBytesPerSecond, 2000);
});

test('defaults to ten requests and preserves the complete URL argument', async (t) => {
  const h = setup(t);
  const address = `${ADDRESS}?q=80&w=1064&format=mp4`;
  const results = await main([address]);
  assert.equal(h.calls.length, 10);
  assert.ok(h.calls.every(([input]) => input === address));
  assert.deepEqual(results.map((result) => result.request), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
  assert.ok(results.every((result) => !result.isDownloading && result.error === undefined && result.sizeBytes === 5));
  assert.equal(process.exitCode, 0);
});

test('calculates average and median per request, including time after the last chunk', async (t) => {
  const h = setup(t);
  h.respondWith(async () => h.calls.length === 1
    ? download(h, [{ bytes: 100, afterMs: 100 }, { bytes: 300, afterMs: 100 }], { endDelayMs: 100 })
    : download(h, [{ bytes: 50, afterMs: 100 }]));
  const before = Date.now();
  const results = await main([ADDRESS, '2']);
  const [first, second] = results as [RequestData, RequestData];
  assert.equal(first.sizeBytes, 400);
  assert.equal(first.durationMs, 300);
  assert.equal(first.speedBytesPerSecond, 400_000 / 300);
  assert.equal(first.medianSpeedBytesPerSecond, 2000);
  assert.equal(second.speedBytesPerSecond, 500);
  assert.equal(second.medianSpeedBytesPerSecond, 500);
  assert.ok(Date.parse(first.startedAt) >= before);
  assert.ok(Date.parse(first.startedAt) <= Date.now());
  assert.ok(results.every((result) => !('speedSamplesBytesPerSecond' in result)));
  assert.deepEqual(h.summary(), {
    requests: 2, successful: 2, failed: 0, sizeBytes: 450, durationMs: 400,
    averageDurationMs: 200,
    averageSpeedBytesPerSecond: 1125,
  });
});

test('uses an odd sample median and ignores zero-duration or empty speed samples', async (t) => {
  const h = setup(t);
  h.respondWith(async () => download(h, [
    { bytes: 10, afterMs: 0 },
    { bytes: 0, afterMs: 0 },
    { bytes: 300, afterMs: 100 },
    { bytes: 100, afterMs: 100 },
    { bytes: 200, afterMs: 100 },
  ]));
  const results = await main([ADDRESS, '1']);
  assert.equal(results[0]!.sizeBytes, 610);
  assert.equal(results[0]!.medianSpeedBytesPerSecond, 2000);
  assert.equal(results[0]!.speedBytesPerSecond, 610_000 / 300);
});

test('summary averages durations across successful, HTTP-failed, and network-failed requests', async (t) => {
  const h = setup(t);
  h.respondWith(async () => {
    const request = h.calls.length;
    if (request === 3) { h.advance(200); throw new Error('connection failed'); }
    return download(h, [{ bytes: 100, afterMs: request === 1 ? 100 : 300 }], {
      status: request === 1 ? 200 : 500,
    });
  });
  const results = await main([ADDRESS, '3']);
  assert.deepEqual(results.map((result) => result.durationMs), [100, 300, 200]);
  assert.deepEqual(h.summary(), {
    requests: 3, successful: 1, failed: 2, sizeBytes: 200, durationMs: 600,
    averageDurationMs: 200,
    averageSpeedBytesPerSecond: 200_000 / 600,
  });
});

test('handles a zero-duration download without Infinity or NaN', async (t) => {
  const h = setup(t);
  h.respondWith(async () => download(h, [{ bytes: 10, afterMs: 0 }]));
  const results = await main([ADDRESS, '1']);
  assert.equal(results[0]!.speedBytesPerSecond, 0);
  assert.equal(results[0]!.medianSpeedBytesPerSecond, null);
  assert.equal((h.summary() as { averageSpeedBytesPerSecond: number }).averageSpeedBytesPerSecond, 0);
});

test('accepts a successful response with no body', async (t) => {
  const h = setup(t);
  h.respondWith(async () => { h.advance(50); return new Response(null, { status: 204 }); });
  const results = await main([ADDRESS, '1']);
  assert.equal(results[0]!.isDownloading, false);
  assert.equal(results[0]!.error, undefined);
  assert.equal(results[0]!.status, 204);
  assert.equal(results[0]!.sizeBytes, 0);
  assert.equal(results[0]!.durationMs, 50);
  assert.equal(results[0]!.speedBytesPerSecond, 0);
  assert.equal(results[0]!.medianSpeedBytesPerSecond, null);
});

test('waits for full body completion before starting the next request', async (t) => {
  const h = setup(t);
  let active = false;
  const events: string[] = [];
  h.respondWith(async () => {
    assert.equal(active, false, 'A previous response body is still active');
    active = true;
    const request = h.calls.length;
    events.push(`start ${request}`);
    return download(h, [{ bytes: 10, afterMs: 100 }, { bytes: 20, afterMs: 100 }], {
      onEnd() { active = false; events.push(`end ${request}`); },
    });
  });
  const results = await main([ADDRESS, '3']);
  assert.equal(active, false);
  assert.deepEqual(events, ['start 1', 'end 1', 'start 2', 'end 2', 'start 3', 'end 3']);
});

for (const status of [404, 429, 500]) {
  test(`records HTTP ${status}, retains its downloaded bytes, and continues`, async (t) => {
    const h = setup(t);
    h.respondWith(async () => download(h, [{ bytes: 100, afterMs: 100 }], {
      status: h.calls.length === 1 ? status : 200,
    }));
    const results = await main([ADDRESS, '2']);
    assert.equal(results[0]!.isDownloading, false);
    assert.notEqual(results[0]!.error, undefined);
    assert.equal(results[0]!.status, status);
    assert.equal(results[0]!.error, `HTTP ${status}`);
    assert.equal(results[0]!.sizeBytes, 100);
    assert.equal(results[1]!.isDownloading, false);
    assert.equal(results[1]!.error, undefined);
    assert.equal(process.exitCode, 1, 'A later success must not clear the failure exit code');
    assert.equal(h.errors.length, 1);
    assert.deepEqual(h.summary(), {
      requests: 2, successful: 1, failed: 1, sizeBytes: 200, durationMs: 200,
      averageDurationMs: 100,
      averageSpeedBytesPerSecond: 1000,
    });
  });
}

test('records a network failure without inventing a status or speed, then continues', async (t) => {
  const h = setup(t);
  h.respondWith(async () => {
    if (h.calls.length === 1) { h.advance(100); throw new TypeError('fetch failed'); }
    return download(h, [{ bytes: 50, afterMs: 100 }]);
  });
  const results = await main([ADDRESS, '2']);
  assert.equal(results[0]!.error, 'fetch failed');
  assert.equal(results[0]!.status, null);
  assert.equal(results[0]!.speedBytesPerSecond, null);
  assert.equal(results[0]!.medianSpeedBytesPerSecond, null);
  assert.equal(results[0]!.sizeBytes, 0);
  assert.equal(results[0]!.durationMs, 100);
  assert.equal(results[1]!.isDownloading, false);
  assert.equal(results[1]!.error, undefined);
  assert.equal(process.exitCode, 1);
});

test('keeps partial measurements after a response stream fails', async (t) => {
  const h = setup(t);
  h.respondWith(async () => download(h, [{ bytes: 20, afterMs: 100 }], {
    endDelayMs: 100, error: new Error('connection reset during download'),
  }));
  const results = await main([ADDRESS, '1']);
  assert.equal(results[0]!.isDownloading, false);
  assert.notEqual(results[0]!.error, undefined);
  assert.equal(results[0]!.status, 200);
  assert.equal(results[0]!.sizeBytes, 20);
  assert.equal(results[0]!.durationMs, 200);
  assert.equal(results[0]!.speedBytesPerSecond, 100);
  assert.equal(results[0]!.medianSpeedBytesPerSecond, 200);
  assert.match(results[0]!.error!, /connection reset/);
  assert.equal(process.exitCode, 1);
});

test('passes the configured timeout signal and records timeout failures without waiting 30 seconds', async (t) => {
  const h = setup(t);
  const signal = AbortSignal.abort(new DOMException('Request timed out', 'TimeoutError'));
  const timeout = t.mock.method(AbortSignal, 'timeout', (ms: number) => {
    assert.equal(ms, 30_000);
    return signal;
  });
  h.respondWith(async (_address, options) => {
    assert.equal(options?.signal, signal);
    options.signal.throwIfAborted();
    throw new Error('Expected abort');
  });
  const results = await main([ADDRESS, '2']);
  assert.equal(timeout.mock.callCount(), 2);
  assert.ok(results.every((result) => !result.isDownloading && result.error !== undefined && result.error === 'Request timed out'));
  assert.equal(process.exitCode, 1);
});

test('records timeouts during body consumption with partial bytes', async (t) => {
  const h = setup(t);
  h.respondWith(async () => download(h, [{ bytes: 10, afterMs: 100 }], {
    error: new DOMException('Download timed out', 'TimeoutError'), endDelayMs: 100,
  }));
  const results = await main([ADDRESS, '1']);
  assert.equal(results[0]!.error, 'Download timed out');
  assert.equal(results[0]!.sizeBytes, 10);
  assert.equal(process.exitCode, 1);
});

for (const thrown of ['unexpected failure', '']) {
  test(`handles non-Error rejection ${JSON.stringify(thrown)}`, async (t) => {
    const h = setup(t);
    h.respondWith(async () => { throw thrown; });
    const results = await main([ADDRESS, '1']);
    assert.equal(results[0]!.isDownloading, false);
    assert.notEqual(results[0]!.error, undefined);
    assert.equal(results[0]!.error, thrown);
    assert.equal(process.exitCode, 1);
  });
}

for (const args of [[], [' '], [ADDRESS, '0'], [ADDRESS, '-1'], [ADDRESS, '1.5'], [ADDRESS, 'abc'], [ADDRESS, 'Infinity'], [ADDRESS, '9007199254740992']]) {
  test(`rejects invalid arguments ${JSON.stringify(args)} before fetching`, async (t) => {
    const h = setup(t);
    const results = await main(args);
    assert.equal(process.exitCode, 1);
    assert.equal(h.calls.length, 0);
    assert.equal(results.length, 0);
    assert.equal(h.errors.length, 1);
    assert.equal(h.logs.length, 0);
  });
}

for (const address of ['not-a-url', '/video.mp4', 'https://', 'ftp://example.com/video.mp4', 'file:///tmp/video.mp4', 'data:text/plain,hello']) {
  test(`rejects invalid or unsupported URL ${JSON.stringify(address)} once before downloading`, async (t) => {
    const h = setup(t);
    const results = await main([address, '10']);
    assert.deepEqual(results, []);
    assert.equal(h.calls.length, 0);
    assert.equal(h.errors.length, 1);
    assert.match(String(h.errors[0]![0]), /valid HTTP or HTTPS URL/);
    assert.equal(h.logs.length, 0);
    assert.equal(process.exitCode, 1);
  });
}

test('accepts an HTTP URL as well as HTTPS', async (t) => {
  const h = setup(t);
  const address = 'http://example.test/video.mp4?q=80&w=1064';
  const results = await main([address, '1']);
  assert.equal(h.calls[0]![0], address);
  assert.equal(results.length, 1);
  assert.equal(results[0]!.error, undefined);
});

test('separate runs retain independent results, summaries, and exit codes', async (t) => {
  const h = setup(t);
  h.respondWith(async () => {
    if (h.calls.length === 1) throw new Error('first run failed');
    return download(h, [{ bytes: 50, afterMs: 100 }]);
  });
  const first = await main([ADDRESS, '1']);
  assert.equal(process.exitCode, 1);
  const second = await main([ADDRESS, '2']);
  assert.equal(process.exitCode, 0);
  assert.notEqual(first, second);
  assert.equal(first.length, 1);
  assert.equal(first[0]!.error, 'first run failed');
  assert.deepEqual(second.map((result) => result.request), [1, 2]);
  assert.ok(second.every((result) => result.error === undefined));
  const summaries = h.logs.filter(([label]) => label === 'Summary:').map(([, summary]) => summary);
  assert.deepEqual(summaries, [
    { requests: 1, successful: 0, failed: 1, sizeBytes: 0, durationMs: 0, averageDurationMs: 0, averageSpeedBytesPerSecond: 0 },
    { requests: 2, successful: 2, failed: 0, sizeBytes: 100, durationMs: 200, averageDurationMs: 100, averageSpeedBytesPerSecond: 500 },
  ]);

  const invalid = await main(['not-a-url']);
  assert.deepEqual(invalid, []);
  assert.equal(first.length, 1);
  assert.equal(second.length, 2);
});

test('throttle calls immediately, skips rapid updates, and forwards arguments at the interval boundary', (t) => {
  const h = setup(t);
  const calls: [string, number][] = [];
  const report = throttle((label: string, value: number) => calls.push([label, value]), 100);
  report('first', 1);
  h.advance(50);
  report('skipped', 2);
  h.advance(49);
  report('also skipped', 3);
  h.advance(1);
  report('boundary', 4);
  h.advance(150);
  report('later', 5);
  assert.deepEqual(calls, [['first', 1], ['boundary', 4], ['later', 5]]);
});

test('throttle instances have independent timing', (t) => {
  setup(t);
  const calls: string[] = [];
  const first = throttle(() => calls.push('first'), 100);
  const second = throttle(() => calls.push('second'), 100);
  first();
  second();
  first();
  second();
  assert.deepEqual(calls, ['first', 'second']);
});

test('throttles terminal refreshes per request while retaining every chunk in measurements', async (t) => {
  const h = setup(t, true);
  h.respondWith(async () => download(h, Array.from({ length: 24 }, () => ({ bytes: 10, afterMs: 10 }))));
  const results = await main([ADDRESS, '2']);
  assert.deepEqual(h.writes, [
    'Downloading 1/2… calculating speed',
    'Downloading 1/2… 0.98 KiB/s',
    'Downloading 1/2… 0.98 KiB/s',
    'Downloading 2/2… calculating speed',
    'Downloading 2/2… 0.98 KiB/s',
    'Downloading 2/2… 0.98 KiB/s',
  ]);
  assert.ok(results.every((result) => result.sizeBytes === 240 && result.durationMs === 240));
  assert.ok(results.every((result) => result.speedBytesPerSecond === 1000 && result.medianSpeedBytesPerSecond === 1000));
  assert.equal(h.logs.filter(([value]) => typeof value === 'object').length, 2);
  assert.deepEqual(h.summary(), {
    requests: 2, successful: 2, failed: 0, sizeBytes: 480, durationMs: 480,
    averageDurationMs: 240,
    averageSpeedBytesPerSecond: 1000,
  });
});

for (const args of [['--help'], ['-h'], [ADDRESS, '--help']]) {
  test(`shows help for ${JSON.stringify(args)} without requests or a summary`, async (t) => {
    const h = setup(t);
    const results = await main(args);
    assert.equal(h.calls.length, 0);
    assert.equal(h.logs.length, 1);
    assert.match(String(h.logs[0]![0]), /requestNumber/);
    assert.match(String(h.logs[0]![0]), /30 seconds/);
    assert.equal(h.errors.length, 0);
    assert.equal(process.exitCode, 0);
  });
}

test('updates one terminal line with speed, then prints full results and a final summary', async (t) => {
  const h = setup(t, true);
  h.respondWith(async () => {
    assert.ok(h.writes.includes('Downloading 1/1… calculating speed'), 'Show progress before fetching');
    return download(h, [{ bytes: 1024, afterMs: 1000 }]);
  });
  const results = await main([ADDRESS, '1']);
  assert.deepEqual(h.writes, ['Downloading 1/1… calculating speed', 'Downloading 1/1… 1.00 KiB/s']);
  assert.ok(h.writes.every((text) => !text.includes('\n')));
  assert.equal(h.logs.length, 2);
  assert.equal((h.logs[0]![0] as RequestData).isDownloading, false);
  assert.equal((h.logs[0]![0] as RequestData).error, undefined);
  assert.equal(h.logs[1]![0], 'Summary:');
  assert.deepEqual(h.terminalEvents, ['clear', 'cursor', 'clear', 'cursor', 'clear', 'cursor', 'clear', 'cursor']);
});

test('clears live progress before printing a terminal error and summary', async (t) => {
  const h = setup(t, true);
  h.respondWith(async () => { throw new Error('connection refused'); });
  const results = await main([ADDRESS, '1']);
  assert.equal(h.writes.length, 1);
  assert.equal((h.errors[0]![0] as RequestData).isDownloading, false);
  assert.notEqual((h.errors[0]![0] as RequestData).error, undefined);
  assert.equal(h.terminalEvents.filter((event) => event === 'clear').length, 3);
  assert.deepEqual(h.summary(), {
    requests: 1, successful: 0, failed: 1, sizeBytes: 0, durationMs: 0,
    averageDurationMs: 0,
    averageSpeedBytesPerSecond: 0,
  });
});

test('piped output prints one start notice and one final record per request without terminal controls', async (t) => {
  const h = setup(t);
  h.respondWith(async () => download(h, [{ bytes: 100, afterMs: 100 }, { bytes: 200, afterMs: 100 }]));
  const results = await main([ADDRESS, '2']);
  assert.equal(h.writes.length, 0);
  assert.equal(h.terminalEvents.length, 0);
  assert.equal(h.logs.filter(([value]) => typeof value === 'string' && value.startsWith('Downloading')).length, 2);
  assert.equal(h.logs.filter(([value]) => typeof value === 'object').length, 2);
  assert.equal(h.logs.at(-1)![0], 'Summary:');
});

test('CLI entry point supports --help and reports invalid arguments with the correct exit codes', () => {
  const entry = new URL('../index.ts', import.meta.url);
  const help = spawnSync(process.execPath, [entry.pathname, '--help'], { encoding: 'utf8', timeout: 5000 });
  assert.equal(help.status, 0, help.stderr);
  assert.match(help.stdout, /Usage:/);
  assert.equal(help.stderr, '');

  const invalid = spawnSync(process.execPath, [entry.pathname, ADDRESS, '0'], { encoding: 'utf8', timeout: 5000 });
  assert.equal(invalid.status, 1);
  assert.match(invalid.stderr, /positive integer/);
  assert.equal(invalid.stdout, '');
});
