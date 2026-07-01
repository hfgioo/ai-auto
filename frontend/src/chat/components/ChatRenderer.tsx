/**
 * 对话渲染组件
 * 使用 ds-markdown 渲染流式 Markdown
 */
import React, { useRef, useEffect } from 'react';
import { Avatar } from 'antd';
import { RobotOutlined, MessageOutlined } from '@ant-design/icons';
import { Markdown } from 'ds-markdown';
import 'ds-markdown/style.css';
import type { ChatMessage, ToolCall } from '../types';
import { MessageBubble } from './MessageBubble';
import { useTheme } from '../../theme';
import styles from './ChatRenderer.module.scss';

export interface ChatRendererProps {
  messages: ChatMessage[];
  streaming?: boolean;
  streamingContent?: string;
  streamingReasoning?: string;
  onRetry?: (messageId: string) => void;
  onCopy?: (content: string) => void;
  renderAvatar?: (role: string) => React.ReactNode;
  renderToolCall?: (toolCall: ToolCall) => React.ReactNode;
  onRemoveContentPart?: (messageId: string, partIndex: number) => void;
  onMediaReedit?: (messageId: string) => void;
  onMediaRegenerate?: (messageId: string) => void;
  onMediaDelete?: (messageId: string) => void;
  onMediaUseAsReference?: (messageId: string, images: import('../../components/chat/chatMediaGeneration').ChatImageRef[]) => void;
  emptyText?: string;
}

// 思考指示器
const ThinkingIndicator: React.FC = () => (
  <div className={styles.thinkingIndicator}>
    <div className={styles.thinkingDots}>
      <span className={styles.thinkingDot} />
      <span className={styles.thinkingDot} />
      <span className={styles.thinkingDot} />
    </div>
    <span>正在思考...</span>
  </div>
);

// 流式消息组件
const StreamingMessage: React.FC<{ content: string; reasoning?: string; mdTheme: 'light' | 'dark' }> = ({ content, reasoning, mdTheme }) => {
  if (!content && !reasoning) {
    return (
      <div className={styles.streamingMessage}>
        <Avatar size={32} icon={<RobotOutlined />} className={styles.assistantAvatar} />
        <div className={styles.streamingContent}>
          <ThinkingIndicator />
        </div>
      </div>
    );
  }

  return (
    <div className={styles.streamingMessage}>
      <Avatar size={32} icon={<RobotOutlined />} className={styles.assistantAvatar} />
      <div className={styles.streamingContent}>
        {reasoning && (
          <div className={styles.reasoningBlock}>
            <div className={styles.reasoningHeader}>
              <span className={styles.reasoningLabel}>正在思考...</span>
            </div>
            <div className={styles.reasoningContent}>
              <pre>{reasoning}</pre>
            </div>
          </div>
        )}
        <Markdown interval={0} disableTyping theme={mdTheme}>{content}</Markdown>
      </div>
    </div>
  );
};

// 空状态
const EmptyState: React.FC<{ text?: string }> = ({ text = '开始对话吧' }) => (
  <div className={styles.emptyState}>
    <MessageOutlined className={styles.emptyIcon} />
    <span className={styles.emptyText}>{text}</span>
  </div>
);

export const ChatRenderer: React.FC<ChatRendererProps> = ({
  messages,
  streaming,
  streamingContent,
  streamingReasoning,
  onRetry,
  onCopy,
  renderAvatar,
  renderToolCall,
  onRemoveContentPart,
  onMediaReedit,
  onMediaRegenerate,
  onMediaDelete,
  onMediaUseAsReference,
  emptyText,
}) => {
  const containerRef = useRef<HTMLDivElement>(null);
  const { theme: activeTheme } = useTheme();
  // ds-markdown 接收 'light' | 'dark' 字面量；按当前主题 mode 派发，避免亮主题下出现暗 markdown 块
  const mdTheme: 'light' | 'dark' = activeTheme.meta.mode === 'light' ? 'light' : 'dark';

  // 自动滚动到底部
  useEffect(() => {
    if (containerRef.current) {
      containerRef.current.scrollTop = containerRef.current.scrollHeight;
    }
  }, [messages, streamingContent, streamingReasoning]);

  if (messages.length === 0 && !streaming) {
    return <EmptyState text={emptyText} />;
  }

  return (
    <div ref={containerRef} className={styles.chatContainer}>
      {messages.map(msg => (
        <MessageBubble
          key={msg.id}
          message={msg}
          mdTheme={mdTheme}
          onRetry={onRetry}
          onCopy={onCopy}
          renderAvatar={renderAvatar}
          renderToolCall={renderToolCall}
          onRemoveContentPart={onRemoveContentPart}
          onMediaReedit={onMediaReedit}
          onMediaRegenerate={onMediaRegenerate}
          onMediaDelete={onMediaDelete}
          onMediaUseAsReference={onMediaUseAsReference}
        />
      ))}

      {streaming && (
        <StreamingMessage content={streamingContent || ''} reasoning={streamingReasoning} mdTheme={mdTheme} />
      )}
    </div>
  );
};

export default ChatRenderer;
