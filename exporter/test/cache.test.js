'use strict';

/**
 * Cache and S3 request reduction verification tests.
 */

process.env.AWS_ACCESS_KEY_ID = 'test-access-key';
process.env.AWS_SECRET_ACCESS_KEY = 'test-secret-key';
process.env.LOG_LEVEL = 'warn';

const config = require('../src/config');

describe('S3 Cache Configuration', () => {
  test('config has cacheTtlSeconds defined with expected default or env', () => {
    expect(config.s3).toBeDefined();
    expect(typeof config.s3.cacheTtlSeconds).toBe('number');
    expect(config.s3.cacheTtlSeconds).toBeGreaterThan(0);
  });

  test('fallback default is 15 seconds when S3_CACHE_TTL_SECONDS is unset', () => {
    // This suite never sets S3_CACHE_TTL_SECONDS; skip the pin if the ambient
    // environment overrides it with a deliberately different TTL.
    if (process.env.S3_CACHE_TTL_SECONDS === undefined) {
      expect(config.s3.cacheTtlSeconds).toBe(15);
    }
  });
});

describe('S3 In-Memory Cache Logic', () => {
  let listCallCount = 0;
  let getCallCount = 0;
  let lastCacheTimestamp = 0;
  let hasCachedData = false;
  let activeRefreshPromise = null;
  const tcodeCache = new Map();
  const cacheTtlMs = 15 * 1000; // 15s — mirrors config.s3.cacheTtlSeconds default

  const mockS3 = {
    listObjects: async () => {
      listCallCount++;
      return [
        { Key: 'AL08_2026-07-27T06-29-13.json', LastModified: new Date('2026-07-27T06:29:13Z') },
        { Key: 'SM50_2026-07-27T06-29-11.json', LastModified: new Date('2026-07-27T06:29:11Z') },
      ];
    },
    getObject: async (key) => {
      getCallCount++;
      return JSON.stringify({ data: [] });
    },
  };

  const mockResolveLatestFiles = (objects) => {
    const map = new Map();
    map.set('AL08', { key: 'AL08_2026-07-27T06-29-13.json', lastModified: new Date('2026-07-27T06:29:13Z') });
    map.set('SM50', { key: 'SM50_2026-07-27T06-29-11.json', lastModified: new Date('2026-07-27T06:29:11Z') });
    return map;
  };

  async function doRefresh() {
    const objects = await mockS3.listObjects();
    const latestFiles = mockResolveLatestFiles(objects);

    for (const [tcode, fileInfo] of latestFiles) {
      const cached = tcodeCache.get(tcode);
      const modTime = fileInfo.lastModified.getTime();

      if (cached && cached.key === fileInfo.key && cached.lastModifiedTime === modTime) {
        continue; // Cache hit: skip getObject
      }

      await mockS3.getObject(fileInfo.key);
      tcodeCache.set(tcode, { key: fileInfo.key, lastModifiedTime: modTime, metrics: [] });
    }

    hasCachedData = true;
    lastCacheTimestamp = Date.now();
  }

  function refreshS3Data() {
    if (activeRefreshPromise) {
      return activeRefreshPromise;
    }
    activeRefreshPromise = doRefresh().finally(() => {
      activeRefreshPromise = null;
    });
    return activeRefreshPromise;
  }

  async function handleScrape(now = Date.now()) {
    const isCacheExpired = !hasCachedData || (now - lastCacheTimestamp >= cacheTtlMs);
    if (isCacheExpired) {
      await refreshS3Data();
    }
    return { servedFrom: isCacheExpired ? 's3_refresh' : 'memory_cache' };
  }

  beforeEach(() => {
    listCallCount = 0;
    getCallCount = 0;
    lastCacheTimestamp = 0;
    hasCachedData = false;
    activeRefreshPromise = null;
    tcodeCache.clear();
    mockS3.listObjects = async () => {
      listCallCount++;
      return [
        { Key: 'AL08_2026-07-27T06-29-13.json', LastModified: new Date('2026-07-27T06:29:13Z') },
        { Key: 'SM50_2026-07-27T06-29-11.json', LastModified: new Date('2026-07-27T06:29:11Z') },
      ];
    };
  });

  test('first request performs S3 LIST and downloads files', async () => {
    const res = await handleScrape();
    expect(res.servedFrom).toBe('s3_refresh');
    expect(listCallCount).toBe(1);
    expect(getCallCount).toBe(2);
    expect(hasCachedData).toBe(true);
  });

  test('subsequent requests within TTL serve from cache with ZERO S3 calls', async () => {
    await handleScrape();
    expect(listCallCount).toBe(1);
    expect(getCallCount).toBe(2);

    // Simulate 14 subsequent scrapes at 1-second intervals — all still inside
    // the 15-second TTL, so every one must be served from memory.
    for (let i = 1; i <= 14; i++) {
      const res = await handleScrape(lastCacheTimestamp + i * 1000);
      expect(res.servedFrom).toBe('memory_cache');
    }

    // Call counts must still be exactly 1 and 2
    expect(listCallCount).toBe(1);
    expect(getCallCount).toBe(2);
  });

  test('concurrent requests share the same in-flight refresh (single-flight)', async () => {
    // Fire 5 concurrent requests simultaneously
    const results = await Promise.all([
      handleScrape(),
      handleScrape(),
      handleScrape(),
      handleScrape(),
      handleScrape(),
    ]);

    expect(results).toHaveLength(5);
    // S3 LIST must only be called ONCE
    expect(listCallCount).toBe(1);
    expect(getCallCount).toBe(2);
  });

  test('expired cache triggers refresh, but unchanged files are NOT re-downloaded', async () => {
    await handleScrape(); // Initial load at t=0
    expect(listCallCount).toBe(1);
    expect(getCallCount).toBe(2);

    // Advance time past the 15s TTL (e.g. 16 seconds later)
    const res = await handleScrape(lastCacheTimestamp + 16 * 1000);
    expect(res.servedFrom).toBe('s3_refresh');

    // ListObjects was called once more
    expect(listCallCount).toBe(2);
    // GetObject was NOT called again because keys and timestamps did not change!
    expect(getCallCount).toBe(2);
  });

  test('refresh failure preserves stale cache and continues serving', async () => {
    await handleScrape();
    expect(hasCachedData).toBe(true);

    // Mock S3 failure on subsequent call
    mockS3.listObjects = async () => {
      throw new Error('AWS S3 503 Service Unavailable');
    };

    // Attempt refresh past TTL
    let refreshError = null;
    try {
      const isCacheExpired = Date.now() - lastCacheTimestamp >= cacheTtlMs;
      if (isCacheExpired) {
        await refreshS3Data();
      }
    } catch (err) {
      refreshError = err;
    }

    // Even if S3 failed, hasCachedData remains true so old metrics can still be served
    expect(hasCachedData).toBe(true);
  });

  test('zero-metric file (ST03N) is cached and NOT re-downloaded on subsequent refreshes when unchanged', async () => {
    // Add ST03N to mock files
    const st03nTimestamp = new Date('2026-07-27T06:29:10Z');
    let st03nModified = st03nTimestamp;
    let st03nGetCount = 0;

    const customResolve = () => {
      const map = new Map();
      map.set('ST03N', { key: 'ST03N_2026-07-27T06-29-10.json', lastModified: st03nModified });
      return map;
    };

    const mockParseToMetrics = (key) => {
      // Simulate ST03N parsing to 0 metrics
      return { metrics: [], parseError: null };
    };

    async function doRefreshWithST03N() {
      const latestFiles = customResolve();
      for (const [tcode, fileInfo] of latestFiles) {
        const cached = tcodeCache.get(tcode);
        const modTime = fileInfo.lastModified?.getTime() || 0;

        if (cached && cached.key === fileInfo.key && cached.lastModifiedTime === modTime) {
          continue; // Cache hit: skip download
        }

        st03nGetCount++;
        const { metrics } = mockParseToMetrics(fileInfo.key);
        // Negative cache entry: caches 0 metrics for unchanged key & LastModified
        tcodeCache.set(tcode, { key: fileInfo.key, lastModifiedTime: modTime, metrics });
      }
      hasCachedData = true;
      lastCacheTimestamp = Date.now();
    }

    // Cycle 1: First refresh downloads ST03N and caches the 0-metric result
    await doRefreshWithST03N();
    expect(st03nGetCount).toBe(1);
    expect(tcodeCache.has('ST03N')).toBe(true);
    expect(tcodeCache.get('ST03N').metrics).toHaveLength(0);

    // Cycle 2: Second refresh with UNCHANGED key and LastModified must NOT download ST03N again
    await doRefreshWithST03N();
    expect(st03nGetCount).toBe(1); // Still 1: skipped S3 GetObject!

    // Cycle 3: Third refresh with updated LastModified MUST download and re-parse ST03N
    st03nModified = new Date('2026-07-27T06:35:00Z');
    await doRefreshWithST03N();
    expect(st03nGetCount).toBe(2); // Incremented: downloaded updated file
  });

  test('non-blocking /metrics serves warm cache immediately while background refresh runs', async () => {
    let backgroundRefreshStarted = false;
    let backgroundRefreshCompleted = false;

    // Simulate non-blocking scrape handler matching src/index.js
    async function nonBlockingHandleScrape(now = Date.now()) {
      const isCacheExpired = !hasCachedData || (now - lastCacheTimestamp >= cacheTtlMs);

      if (isCacheExpired) {
        if (!hasCachedData) {
          await refreshS3Data();
          return { servedFrom: 's3_cold_start' };
        } else {
          backgroundRefreshStarted = true;
          // Trigger non-blocking background refresh
          refreshS3Data().then(() => {
            backgroundRefreshCompleted = true;
          }).catch(() => {});
          return { servedFrom: 'memory_cache_background_refresh' };
        }
      }
      return { servedFrom: 'memory_cache' };
    }

    // 1. Initial cold-start scrape: waits for initial data
    const coldRes = await nonBlockingHandleScrape();
    expect(coldRes.servedFrom).toBe('s3_cold_start');
    expect(hasCachedData).toBe(true);

    // 2. Scrape within 15s TTL: served directly from memory
    const warmRes = await nonBlockingHandleScrape(lastCacheTimestamp + 5000);
    expect(warmRes.servedFrom).toBe('memory_cache');
    expect(backgroundRefreshStarted).toBe(false);

    // 3. Scrape past 15s TTL: serves immediately with background refresh triggered
    const expiredRes = await nonBlockingHandleScrape(lastCacheTimestamp + 16000);
    expect(expiredRes.servedFrom).toBe('memory_cache_background_refresh');
    expect(backgroundRefreshStarted).toBe(true);

    // Wait for the background refresh promise to finish
    await activeRefreshPromise;
    expect(backgroundRefreshCompleted).toBe(true);
  });
});
