// Shared by typed /fork and approved batches. Source guards stay held until snapshots resolve.
export const pendingForkThreads = new Set();
export const pendingForkSources = new Set();
