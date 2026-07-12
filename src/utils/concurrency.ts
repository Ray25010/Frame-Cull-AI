export interface MachineConcurrencyProfile {
  logicalCores?: number;
  deviceMemoryGb?: number;
}

export function chooseAiCullingConcurrency(profile: MachineConcurrencyProfile = readMachineConcurrencyProfile()) {
  const cores = normalizeCores(profile.logicalCores);
  const memoryCap = lowMemoryWorkerCap(profile.deviceMemoryGb);
  let workers = 2;

  if (cores >= 20) workers = 6;
  else if (cores >= 16) workers = 6;
  else if (cores >= 12) workers = 5;
  else if (cores >= 8) workers = 4;
  else if (cores >= 6) workers = 3;

  return Math.max(1, Math.min(workers, memoryCap));
}

export function chooseAiPreparationConcurrency(profile: MachineConcurrencyProfile = readMachineConcurrencyProfile()) {
  const cores = normalizeCores(profile.logicalCores);
  const memoryCap = lowMemoryWorkerCap(profile.deviceMemoryGb);
  let workers = 1;

  if (cores >= 16) workers = 4;
  else if (cores >= 12) workers = 3;
  else if (cores >= 8) workers = 2;

  return Math.max(1, Math.min(workers, memoryCap));
}

export function choosePeopleSplitConcurrency(
  aiCullingRunning: boolean,
  profile: MachineConcurrencyProfile = readMachineConcurrencyProfile(),
) {
  const cores = normalizeCores(profile.logicalCores);
  const memoryCap = lowMemoryWorkerCap(profile.deviceMemoryGb);
  let workers = 2;

  if (aiCullingRunning) {
    if (cores >= 16) workers = 3;
    else if (cores >= 10) workers = 2;
    else workers = 1;
  } else if (cores >= 16) {
    workers = 5;
  } else if (cores >= 12) {
    workers = 4;
  } else if (cores >= 8) {
    workers = 3;
  }

  return Math.max(1, Math.min(workers, memoryCap));
}

export function choosePeopleSplitPreparationConcurrency(
  aiCullingRunning: boolean,
  profile: MachineConcurrencyProfile = readMachineConcurrencyProfile(),
) {
  if (aiCullingRunning) return 1;

  const cores = normalizeCores(profile.logicalCores);
  const memoryCap = lowMemoryWorkerCap(profile.deviceMemoryGb);
  const workers = cores >= 12 ? 2 : 1;
  return Math.max(1, Math.min(workers, memoryCap));
}

export function readMachineConcurrencyProfile(): MachineConcurrencyProfile {
  if (typeof navigator === 'undefined') {
    return { logicalCores: 4 };
  }

  const navigatorWithMemory = navigator as Navigator & { deviceMemory?: number };
  return {
    logicalCores: navigator.hardwareConcurrency || 4,
    deviceMemoryGb: navigatorWithMemory.deviceMemory,
  };
}

function normalizeCores(value: number | undefined) {
  return Number.isFinite(value) && value && value > 0 ? Math.floor(value) : 4;
}

function lowMemoryWorkerCap(deviceMemoryGb: number | undefined) {
  if (!Number.isFinite(deviceMemoryGb) || !deviceMemoryGb) return Number.POSITIVE_INFINITY;
  if (deviceMemoryGb <= 4) return 3;
  return Number.POSITIVE_INFINITY;
}
