/**
 * 全局调用速率限制器（token bucket per category）
 *
 * 解决问题：
 *   一键流水线在跑批量出图 / 出视频时，runWithConcurrency 的内部并发只控制
 *   "同时在飞的请求数"，没限制每分钟总调用数。第三方代理（OpenAI / Anthropic /
 *   chenyme/grok2api）通常在网关侧配 RPM 阈值，撞上 429 之后整批失败。
 *
 * 设计：
 *   1. 按 category（llm / tti / itv / tts）独立计数。同一时刻不同类目互不影响。
 *   2. 经典 token bucket：固定容量 + 固定速率补充。acquire() 等到有 token 才返回。
 *   3. 模块级单例，所有 batch service 在调上游前 await rateLimiter.acquire('llm') 即可。
 *   4. 用户可通过 setRpm(category, rpm) 在运行时调整阈值；项目设置面板用。
 *   5. 速率为 0 = 无限制（绕过桶）。默认值见 DEFAULT_RPM。
 */

export type RateCategory = 'llm' | 'tti' | 'itv' | 'tts';

interface BucketState {
  /** 桶容量（一次最多攒多少 token，等于"突发上限"） */
  capacity: number;
  /** 每秒补充速率 */
  refillPerSecond: number;
  /** 当前可用 token 数（浮点数，便于细粒度补充） */
  tokens: number;
  /** 上次刷新时间戳（毫秒） */
  lastRefillAt: number;
  /** 等待队列：先来先得 */
  waiters: Array<() => void>;
  /** 滚动统计：最近 60 秒内每次 acquire 成功的时间戳 */
  recentAcquires: number[];
}

const DEFAULT_RPM: Record<RateCategory, number> = {
  llm: 60,   // 1 / 秒
  tti: 30,   // 0.5 / 秒
  itv: 10,   // 1 / 6 秒（视频上游通常严格）
  tts: 60,
};

const DEFAULT_BURST_RATIO = 1.5;  // 容量 = RPM × ratio / 60，给一点突发空间

class RateLimiter {
  private buckets = new Map<RateCategory, BucketState>();

  constructor() {
    for (const cat of Object.keys(DEFAULT_RPM) as RateCategory[]) {
      this.setRpm(cat, DEFAULT_RPM[cat]);
    }
  }

  /**
   * 重新设置某类目的 RPM 上限。0 表示无限制（acquire 直接 resolve）。
   * 容量按 RPM × DEFAULT_BURST_RATIO / 60 推导，至少 1。
   */
  setRpm(category: RateCategory, rpm: number): void {
    const safeRpm = Math.max(0, Math.floor(rpm));
    const capacity = safeRpm > 0 ? Math.max(1, Math.ceil((safeRpm * DEFAULT_BURST_RATIO) / 60)) : 0;
    const refillPerSecond = safeRpm / 60;
    const existing = this.buckets.get(category);
    if (existing) {
      existing.capacity = capacity;
      existing.refillPerSecond = refillPerSecond;
      // 当前 token 数夹紧到新容量（缩容时不允许超容）
      existing.tokens = Math.min(existing.tokens, capacity);
      // RPM 提高时立刻唤醒等待者
      this.refill(existing);
      this.flushWaiters(existing);
    } else {
      this.buckets.set(category, {
        capacity,
        refillPerSecond,
        tokens: capacity,
        lastRefillAt: Date.now(),
        waiters: [],
        recentAcquires: [],
      });
    }
  }

  getRpm(category: RateCategory): number {
    const b = this.buckets.get(category);
    return b ? Math.round(b.refillPerSecond * 60) : 0;
  }

  /**
   * 申请一个 token；阻塞直到拿到（或类目无限制立即返回）。
   * 调用方应在真正发起远程请求**之前**调用本方法。
   */
  async acquire(category: RateCategory): Promise<void> {
    const bucket = this.buckets.get(category);
    if (!bucket) {
      // 未注册类目按无限制处理
      return;
    }
    if (bucket.refillPerSecond <= 0) {
      return;  // RPM=0 视为无限制
    }
    this.refill(bucket);
    if (bucket.tokens >= 1) {
      bucket.tokens -= 1;
      this.recordAcquire(bucket);
      return;
    }
    // 没 token 了 → 排队等下一次补充
    await new Promise<void>(resolve => {
      bucket.waiters.push(resolve);
    });
    // 被唤醒时 token 已经被分发；这里只需记账
    this.recordAcquire(bucket);
  }

  /**
   * 取最近 60 秒内每个类目的实际调用数。给 UI 展示用。
   */
  getStats(): Record<RateCategory, { rpm: number; recent60s: number; queueLength: number; capacity: number; tokens: number }> {
    const now = Date.now();
    const result = {} as ReturnType<RateLimiter['getStats']>;
    for (const [cat, bucket] of this.buckets) {
      // 清理超过 60s 的旧记录
      bucket.recentAcquires = bucket.recentAcquires.filter(t => now - t < 60_000);
      result[cat] = {
        rpm: Math.round(bucket.refillPerSecond * 60),
        recent60s: bucket.recentAcquires.length,
        queueLength: bucket.waiters.length,
        capacity: bucket.capacity,
        tokens: Math.round(bucket.tokens * 10) / 10,
      };
    }
    return result;
  }

  // ---- 内部 ----

  private refill(bucket: BucketState): void {
    const now = Date.now();
    const elapsedMs = now - bucket.lastRefillAt;
    if (elapsedMs <= 0) return;
    const add = (bucket.refillPerSecond * elapsedMs) / 1000;
    bucket.tokens = Math.min(bucket.capacity, bucket.tokens + add);
    bucket.lastRefillAt = now;
  }

  private flushWaiters(bucket: BucketState): void {
    while (bucket.tokens >= 1 && bucket.waiters.length > 0) {
      bucket.tokens -= 1;
      const wake = bucket.waiters.shift()!;
      // 异步唤醒避免重入
      Promise.resolve().then(wake);
    }
  }

  private recordAcquire(bucket: BucketState): void {
    bucket.recentAcquires.push(Date.now());
    // 防止数组无限增长
    if (bucket.recentAcquires.length > 1000) {
      bucket.recentAcquires.splice(0, bucket.recentAcquires.length - 1000);
    }
  }
}

const singleton = new RateLimiter();

// 全局后台 tick：每 100ms 检查一次队列；这是补充 token 后唤醒等待者的最简实现。
// 不用 setInterval 累加，直接基于经过时间计算，所以即便 tab 后台也不会丢节拍。
setInterval(() => {
  for (const bucket of (singleton as any).buckets.values()) {
    (singleton as any).refill(bucket);
    (singleton as any).flushWaiters(bucket);
  }
}, 100);

export const rateLimiter = singleton;

/** 便捷封装：包一个异步函数，让它在每次调用前 acquire token。 */
export function withRateLimit<T extends (...args: any[]) => Promise<any>>(
  category: RateCategory,
  fn: T,
): T {
  return (async (...args: Parameters<T>) => {
    await rateLimiter.acquire(category);
    return fn(...args);
  }) as T;
}
