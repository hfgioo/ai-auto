/**
 * Auto Pipeline Panel — 一键流水线运行时的浮动进度面板
 *
 * 设计：
 * - fixed 右下角，可折叠
 * - 列表显示所有 phase 状态
 * - 失败时变红 + 显示错误 + [重试 / 跳过 / 中止]
 * - 全部完成 / 已中止后保留 5 秒供查看，然后自动消失
 */
import React, { useEffect, useState } from 'react';
import { Button, Space, Typography } from 'antd';
import {
  CheckCircleFilled,
  CloseCircleFilled,
  LoadingOutlined,
  MinusOutlined,
  CloseOutlined,
  PlayCircleOutlined,
  StopOutlined,
  ReloadOutlined,
  StepForwardOutlined,
  RocketOutlined,
} from '@ant-design/icons';
import type {
  AutoPipelineRunner,
  PhaseDefinition,
  PhaseState,
  RunnerState,
} from '../../workflow/autoPipelineRunner';

const { Text } = Typography;

interface AutoPipelinePanelProps {
  runner: AutoPipelineRunner;
  phases: PhaseDefinition[];
  onClose: () => void;
}

function statusIcon(status: PhaseState['status']) {
  switch (status) {
    case 'completed':
      return <CheckCircleFilled style={{ color: '#52c41a' }} />;
    case 'failed':
      return <CloseCircleFilled style={{ color: '#ff4d4f' }} />;
    case 'running':
      return <LoadingOutlined style={{ color: '#1677ff' }} />;
    case 'skipped':
      return <StepForwardOutlined style={{ color: '#999' }} />;
    case 'pending':
    default:
      return <span style={{
        display: 'inline-block', width: 14, height: 14,
        borderRadius: '50%', border: '1.5px solid #d9d9d9',
      }} />;
  }
}

function formatDuration(start?: number, end?: number): string {
  if (!start) return '';
  const ms = (end ?? Date.now()) - start;
  if (ms < 1000) return `${ms}ms`;
  const sec = Math.round(ms / 1000);
  if (sec < 60) return `${sec}s`;
  const min = Math.floor(sec / 60);
  return `${min}m ${sec % 60}s`;
}

export const AutoPipelinePanel: React.FC<AutoPipelinePanelProps> = ({ runner, phases, onClose }) => {
  const [state, setState] = useState<RunnerState>(runner.getState());
  const [collapsed, setCollapsed] = useState(false);
  // 用于让 running phase 的耗时实时刷新
  const [, setTick] = useState(0);

  useEffect(() => {
    const unsub = runner.subscribe(setState);
    return unsub;
  }, [runner]);

  // 跑步秒表：每秒刷新一次
  useEffect(() => {
    if (state.status !== 'running' && state.status !== 'paused') return;
    const id = setInterval(() => setTick(t => t + 1), 1000);
    return () => clearInterval(id);
  }, [state.status]);

  // 全部完成或中止 → 5s 后自动收起
  useEffect(() => {
    if (state.status === 'completed' || state.status === 'aborted') {
      const id = setTimeout(onClose, 5000);
      return () => clearTimeout(id);
    }
  }, [state.status, onClose]);

  const phaseById = new Map(phases.map(p => [p.id, p] as const));
  const totalElapsed = formatDuration(state.startedAt, state.endedAt);
  const currentPhaseLabel = state.currentIndex >= 0
    ? phaseById.get(state.phases[state.currentIndex].id)?.label
    : undefined;

  return (
    <div
      role="status"
      aria-live="polite"
      style={{
        position: 'fixed',
        right: 16,
        bottom: 16,
        zIndex: 50,
        width: collapsed ? 280 : 380,
        maxWidth: 'calc(100vw - 32px)',
        background: 'var(--token-bg-surface, rgba(40, 40, 60, 0.95))',
        backdropFilter: 'blur(8px)',
        border: '1px solid var(--token-border-subtle, rgba(255,255,255,0.08))',
        borderRadius: 12,
        boxShadow: '0 20px 50px rgba(0,0,0,0.4)',
        overflow: 'hidden',
        color: 'var(--token-text-primary, #eee)',
      }}
    >
      {/* 头部 */}
      <div style={{
        display: 'flex', alignItems: 'center', gap: 8,
        padding: '10px 12px', borderBottom: '1px solid rgba(255,255,255,0.06)',
      }}>
        <RocketOutlined style={{ color: '#faad14' }} />
        <div style={{ flex: 1, fontSize: 13, fontWeight: 600 }}>
          一键自动到剪辑
        </div>
        {totalElapsed && (
          <Text type="secondary" style={{ fontSize: 11 }}>{totalElapsed}</Text>
        )}
        <Button
          type="text"
          size="small"
          icon={<MinusOutlined />}
          onClick={() => setCollapsed(c => !c)}
          style={{ color: 'inherit' }}
        />
        <Button
          type="text"
          size="small"
          icon={<CloseOutlined />}
          onClick={() => {
            if (state.status === 'running' || state.status === 'paused' || state.status === 'awaiting') {
              runner.abort();
            }
            onClose();
          }}
          style={{ color: 'inherit' }}
        />
      </div>

      {/* 折叠态：仅显示当前阶段 */}
      {collapsed && (
        <div style={{ padding: '8px 12px', display: 'flex', alignItems: 'center', gap: 8 }}>
          {state.currentIndex >= 0 && (
            <>
              {statusIcon(state.phases[state.currentIndex].status)}
              <Text style={{ flex: 1, fontSize: 12, color: 'inherit' }}>
                {currentPhaseLabel}
              </Text>
            </>
          )}
          {state.status === 'completed' && <Text style={{ color: '#52c41a' }}>已完成</Text>}
          {state.status === 'aborted' && <Text type="secondary">已中止</Text>}
        </div>
      )}

      {/* 展开态：完整列表 */}
      {!collapsed && (
        <>
          <div style={{ padding: '8px 12px', maxHeight: 360, overflowY: 'auto' }}>
            {state.phases.map((phaseState, idx) => {
              const def = phaseById.get(phaseState.id);
              if (!def) return null;
              const isCurrent = idx === state.currentIndex && (state.status === 'running' || state.status === 'awaiting' || state.status === 'paused');
              return (
                <div
                  key={phaseState.id}
                  style={{
                    display: 'flex',
                    alignItems: 'flex-start',
                    gap: 8,
                    padding: '6px 4px',
                    borderRadius: 6,
                    background: isCurrent
                      ? (phaseState.status === 'failed' ? 'rgba(255,77,79,0.12)' : 'rgba(22,119,255,0.08)')
                      : undefined,
                  }}
                >
                  <div style={{ paddingTop: 2 }}>
                    {statusIcon(phaseState.status)}
                  </div>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontSize: 12, fontWeight: isCurrent ? 600 : 400 }}>
                      {def.label}
                    </div>
                    {phaseState.error && (
                      <div style={{ fontSize: 11, color: '#ff7875', marginTop: 2, wordBreak: 'break-word' }}>
                        {phaseState.error}
                      </div>
                    )}
                    {phaseState.progressLabel && phaseState.status === 'running' && (
                      <div style={{ fontSize: 11, color: '#aaa', marginTop: 2 }}>
                        {phaseState.progressLabel}
                      </div>
                    )}
                  </div>
                  <Text type="secondary" style={{ fontSize: 10, flexShrink: 0 }}>
                    {phaseState.status === 'running'
                      ? formatDuration(phaseState.startedAt)
                      : phaseState.status === 'completed' || phaseState.status === 'failed'
                        ? formatDuration(phaseState.startedAt, phaseState.endedAt)
                        : ''}
                  </Text>
                </div>
              );
            })}
          </div>

          {/* 操作区 */}
          {state.status === 'awaiting' && (
            <div style={{
              padding: '8px 12px',
              borderTop: '1px solid rgba(255,255,255,0.06)',
              background: 'rgba(255,77,79,0.08)',
              display: 'flex', gap: 6, justifyContent: 'flex-end',
            }}>
              <Button size="small" danger onClick={() => runner.abort()}>中止</Button>
              <Button size="small" onClick={() => runner.skip()}>跳过</Button>
              <Button size="small" type="primary" icon={<ReloadOutlined />} onClick={() => runner.retry()}>重试</Button>
            </div>
          )}
          {(state.status === 'running' || state.status === 'paused') && (
            <div style={{
              padding: '8px 12px',
              borderTop: '1px solid rgba(255,255,255,0.06)',
              display: 'flex', gap: 6, justifyContent: 'flex-end',
            }}>
              {state.status === 'running' ? (
                <Button size="small" icon={<StopOutlined />} onClick={() => runner.pause()}>暂停</Button>
              ) : (
                <Button size="small" type="primary" icon={<PlayCircleOutlined />} onClick={() => runner.resume()}>继续</Button>
              )}
              <Button size="small" danger onClick={() => runner.abort()}>中止</Button>
            </div>
          )}
        </>
      )}

      {/* 底部状态条 */}
      {state.status === 'completed' && (
        <div style={{ padding: '8px 12px', textAlign: 'center', background: 'rgba(82,196,26,0.12)' }}>
          <Space size={6}>
            <CheckCircleFilled style={{ color: '#52c41a' }} />
            <Text style={{ color: '#52c41a', fontSize: 12 }}>全部完成</Text>
          </Space>
        </div>
      )}
      {state.status === 'aborted' && (
        <div style={{ padding: '8px 12px', textAlign: 'center', background: 'rgba(120,120,120,0.12)' }}>
          <Text type="secondary" style={{ fontSize: 12 }}>流水线已中止</Text>
        </div>
      )}
    </div>
  );
};
