export type RequestData = {
  request: number;
  isDownloading: boolean;
  startedAt: string;
  status: number | null;
  sizeBytes: number;
  durationMs: number;
  speedBytesPerSecond: number | null;
  medianSpeedBytesPerSecond: number | null;
  error?: string;
};
