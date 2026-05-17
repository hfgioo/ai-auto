/**
 * Auto Pipeline Runner — "一键自动到剪辑"的纯执行内核
 *
 * 设计要点：
 * 1. 与 React 解耦：不直接调用任何 service，由调用方用 buildPipelinePhases 注入 phase.run
 *    每个 run 是 () => Promise<void>，runner 只负责按顺序执行 + 处理失败。
 *
 * 2. 失败暂停 + 用户决策：phase.run 抛错 → state.status='failed' → 通知监听者，
 *    等待用户调用 retry() / skip() / abort() 才继续推进。
 *
 * 3. 阶段可勾选：Pipeline 启动时传入 enabledPhaseIds 集合，未勾的 phase 进入 skipped 态被跳过。
 *
 * 4. 状态广播：runner 是个观察者模式，UI 通过 subscribe(listener) 拿增量 state，
 *    类似 Redux/Zustand 但更轻量。
 *
 * 不在本文件管的事：
 * - 具体的 polishScript / batchGenerateShotImages 等业务调用 → buildPipelinePhases 工厂里写
 * - UI 渲染 → AutoPipelinePanel 组件订阅 state 自己绘
 * - 持久化 / 跨会话恢复 → 暂不支持，runner 跟着 React 组件生命周期走
 */

export type PhaseStatus = 'pending' | 'running' | 'completed' | 'failed' | 'skipped';

export type PhaseGroup = 'script' | 'assets' | 'storyboard' | 'audio' | 'final';

export interface PhaseDefinition {
  /** 唯一 id，UI 也用作 key */
  id: string;
  /** 分组（仅 UI 用） */
  group: PhaseGroup;
  /** 显示名 */
  label: string;
  /** 默认是否勾选 */
  defaultEnabled: boolean;
  /** 依赖的其它 phase id；任何依赖被取消勾选时，本 phase 也自动取消 */
  dependsOn?: string[];
  /** 业务执行体；抛异常 = 失败。runner 不会传 abort signal，由 phase 内部自管。 */
  run: () => Promise<void>;
}

export interface PhaseState {
  id: string;
  status: PhaseStatus;
  /** 进入 running 的时间戳（毫秒） */
  startedAt?: number;
  /** 进入 completed/failed/skipped 的时间戳 */
  endedAt?: number;
  /** failed 时的错误文案（从 Error.message 提取） */
  error?: string;
  /** 实时进度文本，phase 内部可通过 setProgress 写入 */
  progressLabel?: string;
}

export type RunnerStatus =
  | 'idle'         // 还没启动
  | 'running'      // 正在跑
  | 'paused'       // 用户暂停
  | 'awaiting'     // 某 phase 失败，等用户决策
  | 'completed'    // 全部跑完
  | 'aborted';     // 用户中止

export interface RunnerState {
  status: RunnerStatus;
  /** 当前 phase 在 phases 数组里的下标；未启动 / 已结束时为 -1 */
  currentIndex: number;
  phases: PhaseState[];
  /** 总开始时间 */
  startedAt?: number;
  /** 总结束时间 */
  endedAt?: number;
}

export interface PhaseRuntimeContext {
  /** 让 phase 写实时进度文案到 UI；不影响流转 */
  setProgressLabel: (label: string) => void;
}

export type RunnerListener = (state: RunnerState) => void;

export interface AutoPipelineRunnerOptions {
  phases: PhaseDefinition[];
  /** 仅这些 id 会被执行；其它直接跳过 */
  enabledPhaseIds: ReadonlySet<string>;
}

/**
 * 一次性使用的运行器实例。每次启动新流水线 `new AutoPipelineRunner(...).start()`。
 */
export class AutoPipelineRunner {
  private readonly phases: PhaseDefinition[];
  private readonly enabledIds: ReadonlySet<string>;
  private state: RunnerState;
  private listeners = new Set<RunnerListener>();
  /** 当前 phase 的 deferred resolver / rejecter；retry / skip / abort 通过它推进 */
  private currentResume?: { resolve: () => void; reject: (err: Error) => void };

  constructor(opts: AutoPipelineRunnerOptions) {
    this.phases = opts.phases;
    this.enabledIds = opts.enabledPhaseIds;
    this.state = {
      status: 'idle',
      currentIndex: -1,
      phases: this.phases.map(p => ({
        id: p.id,
        status: this.enabledIds.has(p.id) ? 'pending' : 'skipped',
      })),
    };
  }

  getState(): RunnerState {
    return this.state;
  }

  subscribe(listener: RunnerListener): () => void {
    this.listeners.add(listener);
    listener(this.state);
    return () => this.listeners.delete(listener);
  }

  /** 启动流水线；会一直跑到所有 phase 完成 / 用户 abort。throw 表示 abort 或意外异常。 */
  async start(): Promise<void> {
    if (this.state.status !== 'idle') {
      throw new Error('Pipeline runner already started');
    }
    this.update({ status: 'running', startedAt: Date.now() });

    for (let i = 0; i < this.phases.length; i += 1) {
      const def = this.phases[i];
      if (!this.enabledIds.has(def.id)) {
        this.updatePhase(i, { status: 'skipped', endedAt: Date.now() });
        continue;
      }

      this.update({ currentIndex: i });
      await this.runPhaseWithRetry(i);

      // runPhaseWithRetry 返回后说明该阶段已 completed 或被用户 skip。abort 会从循环中抛错退出。
      if (this.state.status === ('aborted' as RunnerStatus)) {
        return;
      }
    }

    this.update({
      status: 'completed',
      currentIndex: -1,
      endedAt: Date.now(),
    });
  }

  /** 失败后用户点"重试" */
  retry(): void {
    if (this.state.status !== 'awaiting') return;
    const idx = this.state.currentIndex;
    if (idx < 0) return;
    this.updatePhase(idx, { status: 'pending', error: undefined, endedAt: undefined });
    this.update({ status: 'running' });
    this.currentResume?.resolve();
  }

  /** 失败后用户点"跳过" */
  skip(): void {
    if (this.state.status !== 'awaiting') return;
    const idx = this.state.currentIndex;
    if (idx < 0) return;
    this.updatePhase(idx, { status: 'skipped', error: undefined, endedAt: Date.now() });
    this.update({ status: 'running' });
    this.currentResume?.resolve();
  }

  /** 用户主动中止 */
  abort(): void {
    if (this.state.status === 'completed' || this.state.status === 'aborted') return;
    this.update({ status: 'aborted', currentIndex: -1, endedAt: Date.now() });
    this.currentResume?.reject(new Error('Pipeline aborted by user'));
  }

  /** 暂停（不影响当前 phase，下一阶段开始前停止）；当前实现是简化版：仅在 awaiting 时才允许 */
  pause(): void {
    if (this.state.status !== 'running') return;
    this.update({ status: 'paused' });
  }

  /** 恢复 */
  resume(): void {
    if (this.state.status !== 'paused') return;
    this.update({ status: 'running' });
  }

  // --- 内部 ---

  private async runPhaseWithRetry(index: number): Promise<void> {
    while (true) {
      const def = this.phases[index];
      this.updatePhase(index, {
        status: 'running',
        startedAt: Date.now(),
        endedAt: undefined,
        error: undefined,
        progressLabel: undefined,
      });

      const ctx: PhaseRuntimeContext = {
        setProgressLabel: (label: string) => {
          this.updatePhase(index, { progressLabel: label });
        },
      };
      // 当前 phase 不直接接 ctx；run 是无参 Promise，但我们把 ctx 暂存以备未来调整。
      // (保留 ctx 占位以便日后让 phase 接进度文案)
      void ctx;

      try {
        await def.run();
        this.updatePhase(index, { status: 'completed', endedAt: Date.now() });
        return;
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        this.updatePhase(index, {
          status: 'failed',
          endedAt: Date.now(),
          error: message,
        });
        this.update({ status: 'awaiting' });

        // 等用户调 retry / skip / abort
        try {
          await new Promise<void>((resolve, reject) => {
            this.currentResume = { resolve, reject };
          });
        } catch (abortErr) {
          throw abortErr;
        } finally {
          this.currentResume = undefined;
        }

        // 用户选了 retry → 当前 phase 状态被重置为 pending → 循环重来
        // 用户选了 skip → phase 状态已是 skipped → 跳出循环
        if (this.state.phases[index].status === 'skipped') return;
      }
    }
  }

  private update(patch: Partial<RunnerState>): void {
    this.state = { ...this.state, ...patch };
    this.emit();
  }

  private updatePhase(index: number, patch: Partial<PhaseState>): void {
    const phases = this.state.phases.slice();
    phases[index] = { ...phases[index], ...patch };
    this.state = { ...this.state, phases };
    // 仅 progressLabel 变化时节流，其他状态变化（status / startedAt / endedAt / error）立刻 emit
    const onlyProgress = Object.keys(patch).length === 1 && 'progressLabel' in patch;
    if (onlyProgress) {
      this.scheduleEmit();
    } else {
      this.emit();
    }
  }

  private scheduledEmit = false;
  private scheduleEmit(): void {
    if (this.scheduledEmit) return;
    this.scheduledEmit = true;
    setTimeout(() => {
      this.scheduledEmit = false;
      this.emit();
    }, 250);
  }

  private emit(): void {
    for (const listener of this.listeners) {
      try {
        listener(this.state);
      } catch (err) {
        console.error('[AutoPipelineRunner] listener error', err);
      }
    }
  }
}

/**
 * 应用层级联校验：根据 dependsOn 关系，把"取消勾选"的阶段对应的下游也取消。
 *
 * 给 UI 用：用户在配置 Modal 里勾选/取消时调本函数，得到合法集合后再渲染。
 */
export function reconcileEnabledPhases(
  phases: ReadonlyArray<PhaseDefinition>,
  enabled: ReadonlySet<string>,
): Set<string> {
  const result = new Set(enabled);
  let changed = true;
  while (changed) {
    changed = false;
    for (const phase of phases) {
      if (!result.has(phase.id)) continue;
      for (const dep of phase.dependsOn ?? []) {
        if (!result.has(dep)) {
          result.delete(phase.id);
          changed = true;
          break;
        }
      }
    }
  }
  return result;
}

/**
 * 反向级联：勾选某 phase 时，把其依赖也勾上。
 */
export function expandEnabledWithDependencies(
  phases: ReadonlyArray<PhaseDefinition>,
  enabled: ReadonlySet<string>,
): Set<string> {
  const result = new Set(enabled);
  const byId = new Map(phases.map(p => [p.id, p] as const));
  let changed = true;
  while (changed) {
    changed = false;
    for (const id of Array.from(result)) {
      const phase = byId.get(id);
      if (!phase) continue;
      for (const dep of phase.dependsOn ?? []) {
        if (!result.has(dep)) {
          result.add(dep);
          changed = true;
        }
      }
    }
  }
  return result;
}
