/**
 * Auto Pipeline Setup Modal — 启动一键流水线前的"勾选要执行的阶段"配置 UI
 *
 * 设计：
 * - 按 group 分组渲染
 * - 用户勾选/取消时通过 expandEnabledWithDependencies / reconcileEnabledPhases 自动级联
 * - [全选] [全不选] 提供快捷
 * - 启动时把最终勾选集合（Set<string>）+ 是否低负载模式传给上层
 */
import React, { useMemo, useState } from 'react';
import { Modal, Checkbox, Button, Space, Typography, Divider, Switch, Tooltip } from 'antd';
import { RocketOutlined, ThunderboltOutlined } from '@ant-design/icons';
import {
  expandEnabledWithDependencies,
  reconcileEnabledPhases,
  type PhaseDefinition,
  type PhaseGroup,
} from '../../workflow/autoPipelineRunner';

const { Title, Text } = Typography;

const GROUP_LABELS: Record<PhaseGroup, string> = {
  script: '剧本预处理',
  assets: '资产准备',
  storyboard: '分镜生成',
  audio: '配音',
  final: '进入剪辑',
};

const GROUP_ORDER: PhaseGroup[] = ['script', 'assets', 'storyboard', 'audio', 'final'];

interface AutoPipelineSetupModalProps {
  open: boolean;
  phases: PhaseDefinition[];
  onCancel: () => void;
  onStart: (enabledIds: Set<string>, options: { lowLoadMode: boolean }) => void;
}

export const AutoPipelineSetupModal: React.FC<AutoPipelineSetupModalProps> = ({
  open,
  phases,
  onCancel,
  onStart,
}) => {
  // 默认勾选 = 各 phase.defaultEnabled
  const initialEnabled = useMemo(() => {
    const set = new Set<string>();
    for (const p of phases) {
      if (p.defaultEnabled) set.add(p.id);
    }
    // 默认值也走依赖展开（防止默认勾选不闭合）
    return reconcileEnabledPhases(phases, set);
  }, [phases]);

  const [enabled, setEnabled] = useState<Set<string>>(initialEnabled);
  const [lowLoadMode, setLowLoadMode] = useState<boolean>(false);

  const toggle = (phaseId: string) => {
    setEnabled(prev => {
      const next = new Set(prev);
      if (next.has(phaseId)) {
        next.delete(phaseId);
        return reconcileEnabledPhases(phases, next);
      } else {
        next.add(phaseId);
        return expandEnabledWithDependencies(phases, next);
      }
    });
  };

  const selectAll = () => setEnabled(new Set(phases.map(p => p.id)));
  const selectNone = () => setEnabled(new Set());

  const phasesByGroup = useMemo(() => {
    const map = new Map<PhaseGroup, PhaseDefinition[]>();
    for (const p of phases) {
      const list = map.get(p.group) || [];
      list.push(p);
      map.set(p.group, list);
    }
    return map;
  }, [phases]);

  return (
    <Modal
      title={
        <Space>
          <RocketOutlined />
          <span>一键自动到剪辑</span>
        </Space>
      }
      open={open}
      onCancel={onCancel}
      width={580}
      mask={{ closable: false }}
      footer={[
        <Button key="all" size="small" onClick={selectAll}>全选</Button>,
        <Button key="none" size="small" onClick={selectNone}>全不选</Button>,
        <span key="spacer" style={{ flex: 1 }} />,
        <Button key="cancel" onClick={onCancel}>取消</Button>,
        <Button
          key="start"
          type="primary"
          icon={<RocketOutlined />}
          disabled={enabled.size === 0}
          onClick={() => onStart(enabled, { lowLoadMode })}
        >
          启动（{enabled.size} / {phases.length}）
        </Button>,
      ]}
      styles={{
        footer: { display: 'flex', alignItems: 'center', gap: 8 },
      }}
    >
      <Text type="secondary">
        选择要自动执行的阶段。某些阶段依赖前置（如出视频依赖出图），勾选时会自动联动。失败时流水线暂停，可重试 / 跳过 / 中止。
      </Text>

      <Divider style={{ margin: '12px 0' }} />

      {/* 低负载模式开关 */}
      <div style={{
        display: 'flex',
        alignItems: 'center',
        gap: 12,
        padding: '8px 12px',
        marginBottom: 12,
        background: 'rgba(250, 173, 20, 0.06)',
        border: '1px solid rgba(250, 173, 20, 0.2)',
        borderRadius: 6,
      }}>
        <ThunderboltOutlined style={{ color: '#faad14', fontSize: 16 }} />
        <div style={{ flex: 1 }}>
          <div style={{ fontSize: 13, fontWeight: 500 }}>低负载模式</div>
          <Text type="secondary" style={{ fontSize: 11 }}>
            参考图并发降为 1，所有上游 RPM 减半。跑得慢但 UI 不卡，散热好。
          </Text>
        </div>
        <Tooltip title={lowLoadMode ? '关闭后恢复满速' : '打开后跑得慢但更稳'}>
          <Switch checked={lowLoadMode} onChange={setLowLoadMode} />
        </Tooltip>
      </div>

      {GROUP_ORDER.map(group => {
        const list = phasesByGroup.get(group);
        if (!list || list.length === 0) return null;
        return (
          <div key={group} style={{ marginBottom: 16 }}>
            <Title level={5} style={{ marginBottom: 8 }}>{GROUP_LABELS[group]}</Title>
            <Space direction="vertical" size={6} style={{ width: '100%', paddingLeft: 8 }}>
              {list.map(phase => (
                <Checkbox
                  key={phase.id}
                  checked={enabled.has(phase.id)}
                  onChange={() => toggle(phase.id)}
                >
                  {phase.label}
                  {phase.dependsOn && phase.dependsOn.length > 0 && (
                    <Text type="secondary" style={{ marginLeft: 8, fontSize: 11 }}>
                      依赖：{phase.dependsOn.join(' / ')}
                    </Text>
                  )}
                </Checkbox>
              ))}
            </Space>
          </div>
        );
      })}
    </Modal>
  );
};
