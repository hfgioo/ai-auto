/**
 * useUndoRedo — 参数化状态 + 历史栈 + undo/redo
 *
 * 设计要点：
 * 1. 不是"每次 setState 都进栈"。调用方决定何时入栈：调 commit() 才推一笔。
 *    适合连续拖拽场景：拖动期间一直 setState，松开时 commit() 一次。
 * 2. 如果调用方只想"立刻入栈 + setState 一步到位"，用 set() 即可。
 * 3. undo/redo 仅在历史栈位移；不会重复 trigger 业务副作用（持久化等由外层 useEffect
 *    监听 state 自行处理）。
 * 4. 最大 50 步；超过自动丢弃最旧。
 *
 * API：
 *   const [state, { set, commit, undo, redo, canUndo, canRedo, reset }] = useUndoRedo(initialState);
 *
 *   set(next)      —— 改 state，**不入栈**（拖拽中用）
 *   commit(next)   —— 改 state，**入栈**
 *   undo()         —— 回退到上一笔（无历史时无操作）
 *   redo()         —— 前进到下一笔
 *   reset(next)    —— 清空历史栈，重置为某状态
 */

import { useCallback, useRef, useState } from 'react';

const MAX_HISTORY = 50;

export interface UndoRedoApi<T> {
  /** 不入栈地更新（用于拖动 / 节流场景） */
  set: (next: T | ((prev: T) => T)) => void;
  /** 入栈地更新（结束态调用） */
  commit: (next: T | ((prev: T) => T)) => void;
  /** 回退；返回是否成功 */
  undo: () => boolean;
  /** 前进；返回是否成功 */
  redo: () => boolean;
  /** 当前是否可 undo */
  canUndo: boolean;
  /** 当前是否可 redo */
  canRedo: boolean;
  /** 清空历史并重置 */
  reset: (next: T) => void;
}

export function useUndoRedo<T>(initial: T): [T, UndoRedoApi<T>] {
  // current = past + [present] + future；React state 只暴露 present，但内部 ref 保完整栈
  const [state, setState] = useState<T>(initial);
  const pastRef = useRef<T[]>([]);
  const futureRef = useRef<T[]>([]);
  const [, forceTick] = useState(0);

  const resolve = (next: T | ((prev: T) => T), prev: T): T => {
    return typeof next === 'function' ? (next as (p: T) => T)(prev) : next;
  };

  const set = useCallback((next: T | ((prev: T) => T)) => {
    setState(prev => resolve(next, prev));
  }, []);

  const commit = useCallback((next: T | ((prev: T) => T)) => {
    setState(prev => {
      const resolved = resolve(next, prev);
      // 没变化不入栈（避免无效历史）
      if (resolved === prev) return prev;
      pastRef.current.push(prev);
      if (pastRef.current.length > MAX_HISTORY) {
        pastRef.current.shift();
      }
      futureRef.current = []; // 任何新提交都丢弃 future（经典 undo 语义）
      forceTick(t => t + 1);  // 让 canUndo/canRedo 派生值刷新
      return resolved;
    });
  }, []);

  const undo = useCallback((): boolean => {
    if (pastRef.current.length === 0) return false;
    setState(prev => {
      const last = pastRef.current.pop()!;
      futureRef.current.push(prev);
      if (futureRef.current.length > MAX_HISTORY) {
        futureRef.current.shift();
      }
      forceTick(t => t + 1);
      return last;
    });
    return true;
  }, []);

  const redo = useCallback((): boolean => {
    if (futureRef.current.length === 0) return false;
    setState(prev => {
      const next = futureRef.current.pop()!;
      pastRef.current.push(prev);
      if (pastRef.current.length > MAX_HISTORY) {
        pastRef.current.shift();
      }
      forceTick(t => t + 1);
      return next;
    });
    return true;
  }, []);

  const reset = useCallback((next: T) => {
    pastRef.current = [];
    futureRef.current = [];
    setState(next);
    forceTick(t => t + 1);
  }, []);

  return [state, {
    set,
    commit,
    undo,
    redo,
    canUndo: pastRef.current.length > 0,
    canRedo: futureRef.current.length > 0,
    reset,
  }];
}
