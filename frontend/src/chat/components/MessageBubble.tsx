/**
 * 消息气泡组件
 */
import React, { useState, useMemo } from 'react';
import { Avatar, Typography, Button, Tooltip, Image as AntImage } from 'antd';
import { UserOutlined, RobotOutlined, CopyOutlined, ReloadOutlined, DownOutlined, RightOutlined, FileOutlined, CloseOutlined } from '@ant-design/icons';
import { Markdown } from 'ds-markdown';
import type { ChatMessage, ToolCall, ImageContentPart, FileContentPart, VideoContentPart, ContentPart } from '../types';
import { normalizeMessage } from '../utils/messageUtils';
import { MediaResultBlock } from '../../components/chat/MediaResultBlock';
import type { MediaResultMeta } from '../../components/chat/chatMediaGeneration';
import styles from './ChatRenderer.module.scss';

const { Text } = Typography;

interface MessageBubbleProps {
  message: ChatMessage;
  mdTheme: 'light' | 'dark';
  onRetry?: (messageId: string) => void;
  onCopy?: (content: string) => void;
  renderAvatar?: (role: string) => React.ReactNode;
  renderToolCall?: (toolCall: ToolCall) => React.ReactNode;
  /** messageId 作为第一个参数，方便本组件用 React.memo 时把回调原样透传（不用每条消息各建一个闭包） */
  onRemoveContentPart?: (messageId: string, partIndex: number) => void;
  onMediaReedit?: (messageId: string) => void;
  onMediaRegenerate?: (messageId: string) => void;
  onMediaDelete?: (messageId: string) => void;
  onMediaUseAsReference?: (messageId: string, images: import('../../components/chat/chatMediaGeneration').ChatImageRef[]) => void;
}

const MessageBubbleImpl: React.FC<MessageBubbleProps> = ({
  message,
  mdTheme,
  onRetry,
  onCopy,
  renderAvatar,
  renderToolCall,
  onRemoveContentPart,
  onMediaReedit,
  onMediaRegenerate,
  onMediaDelete,
  onMediaUseAsReference,
}) => {
  const isUser = message.role === 'user';
  const isAssistant = message.role === 'assistant';
  const isTool = message.role === 'tool';
  const [reasoningExpanded, setReasoningExpanded] = useState(false);

  // 归一化消息内容（兜底处理 <think> 标签）
  const { displayContent, displayReasoning } = useMemo(
    () => normalizeMessage(message),
    [message]
  );

  // 拆出 ContentPart[] 中的图片 / 视频 / 文件附件，保留原索引以支持删除
  const { imageParts, videoParts, fileParts } = useMemo(() => {
    if (typeof message.content === 'string') {
      return {
        imageParts: [] as Array<{ part: ImageContentPart; index: number }>,
        videoParts: [] as Array<{ part: VideoContentPart; index: number }>,
        fileParts: [] as Array<{ part: FileContentPart; index: number }>,
      };
    }
    const imgs: Array<{ part: ImageContentPart; index: number }> = [];
    const vids: Array<{ part: VideoContentPart; index: number }> = [];
    const files: Array<{ part: FileContentPart; index: number }> = [];
    (message.content as ContentPart[]).forEach((part, index) => {
      if (part.type === 'image') imgs.push({ part, index });
      else if (part.type === 'video') vids.push({ part, index });
      else if (part.type === 'file') files.push({ part, index });
    });
    return { imageParts: imgs, videoParts: vids, fileParts: files };
  }, [message.content]);

  const handleCopy = () => {
    navigator.clipboard.writeText(displayContent);
    onCopy?.(displayContent);
  };

  const renderDefaultAvatar = () => {
    if (renderAvatar) {
      return renderAvatar(message.role);
    }

    if (isUser) {
      return (
        <Avatar size={32} icon={<UserOutlined />} className={styles.userAvatar} />
      );
    }

    return (
      <Avatar size={32} icon={<RobotOutlined />} className={styles.assistantAvatar} />
    );
  };

  if (isTool) {
    return (
      <div className={styles.toolMessage}>
        <Text type="secondary" className={styles.toolLabel}>
          工具结果: {message.name}
        </Text>
        <pre className={styles.toolContent}>{displayContent}</pre>
      </div>
    );
  }

  // 媒体结果消息：检测到 metadata.mediaResult 即走专用卡片渲染
  const mediaResult = (message.metadata as { mediaResult?: MediaResultMeta } | undefined)?.mediaResult;
  if (isAssistant && mediaResult && mediaResult.kind === 'media-result') {
    return (
      <div className={`${styles.messageBubble} ${styles.assistantBubble}`}>
        <div className={styles.avatarWrapper}>{renderDefaultAvatar()}</div>
        <div className={styles.messageContent}>
          <MediaResultBlock
            meta={mediaResult}
            onReedit={onMediaReedit ? () => onMediaReedit(message.id) : undefined}
            onRegenerate={onMediaRegenerate ? () => onMediaRegenerate(message.id) : undefined}
            onDelete={onMediaDelete ? () => onMediaDelete(message.id) : undefined}
            onUseAsReference={onMediaUseAsReference ? (images) => onMediaUseAsReference(message.id, images) : undefined}
          />
        </div>
      </div>
    );
  }

  return (
    <div className={`${styles.messageBubble} ${isUser ? styles.userBubble : styles.assistantBubble}`}>
      <div className={styles.avatarWrapper}>
        {renderDefaultAvatar()}
      </div>

      <div className={styles.messageContent}>
        <div className={styles.messageBody}>
          {/* 思考过程展示（使用归一化后的 displayReasoning） */}
          {isAssistant && displayReasoning && (
            <div className={styles.reasoningBlock}>
              <div
                className={styles.reasoningHeader}
                onClick={() => setReasoningExpanded(!reasoningExpanded)}
              >
                {reasoningExpanded ? <DownOutlined /> : <RightOutlined />}
                <span className={styles.reasoningLabel}>思考过程</span>
              </div>
              {reasoningExpanded && (
                <div className={styles.reasoningContent}>
                  <pre>{displayReasoning}</pre>
                </div>
              )}
            </div>
          )}
          {displayContent && (
            isUser
              ? <span>{displayContent}</span>
              : <Markdown interval={0} disableTyping theme={mdTheme}>{displayContent}</Markdown>
          )}

          {imageParts.length > 0 && (
            <div className={styles.attachmentImages}>
              {imageParts.map(({ part, index }) => {
                const src = part.imageUrl
                  || (part.imageBase64 ? `data:${part.mimeType || 'image/png'};base64,${part.imageBase64}` : undefined);
                if (!src) return null;
                return (
                  <div key={`img-${index}`} className={styles.attachmentImageWrapper}>
                    <AntImage
                      src={src}
                      alt={`附件 ${index + 1}`}
                      className={styles.attachmentImage}
                    />
                    {onRemoveContentPart && (
                      <button
                        type="button"
                        className={styles.attachmentRemove}
                        onClick={() => onRemoveContentPart(message.id, index)}
                        aria-label="删除"
                      >
                        <CloseOutlined />
                      </button>
                    )}
                  </div>
                );
              })}
            </div>
          )}

          {videoParts.length > 0 && (
            <div className={styles.attachmentVideos}>
              {videoParts.map(({ part, index }) => (
                <div key={`vid-${index}`} className={styles.attachmentVideoWrapper}>
                  <video
                    src={part.videoUrl}
                    poster={part.poster}
                    controls
                    className={styles.attachmentVideo}
                  />
                  {onRemoveContentPart && (
                    <button
                      type="button"
                      className={styles.attachmentRemove}
                      onClick={() => onRemoveContentPart(message.id, index)}
                      aria-label="删除"
                    >
                      <CloseOutlined />
                    </button>
                  )}
                </div>
              ))}
            </div>
          )}

          {fileParts.length > 0 && (
            <div className={styles.attachmentFiles}>
              {fileParts.map(({ part, index }) => (
                <div key={`file-${index}`} className={styles.attachmentFile}>
                  <FileOutlined />
                  <span className={styles.attachmentFileName}>{part.fileName}</span>
                  {onRemoveContentPart && (
                    <button
                      type="button"
                      className={styles.attachmentRemoveInline}
                      onClick={() => onRemoveContentPart(message.id, index)}
                      aria-label="删除"
                    >
                      <CloseOutlined />
                    </button>
                  )}
                </div>
              ))}
            </div>
          )}

          {message.toolCalls?.map((tc, index) => (
            <div key={tc.id || index} className={styles.toolCallWrapper}>
              {renderToolCall ? (
                renderToolCall(tc)
              ) : (
                <div className={styles.toolCall}>
                  <Text type="secondary">调用工具: {tc.name}</Text>
                  <pre className={styles.toolArgs}>
                    {JSON.stringify(tc.arguments, null, 2)}
                  </pre>
                </div>
              )}
            </div>
          ))}
        </div>

        {/* 操作区：assistant 与 user 都给"复制"，仅 assistant 给"重新生成"。
            之前 isAssistant 包了整个块导致用户消息无法复制——回归到"复制对所有消息可用"。*/}
        {(isAssistant || isUser) && displayContent && (
          <div className={styles.messageActions}>
            <Tooltip title="复制">
              <Button
                type="text"
                size="small"
                icon={<CopyOutlined />}
                onClick={handleCopy}
              />
            </Tooltip>
            {isAssistant && onRetry && (
              <Tooltip title="重新生成">
                <Button
                  type="text"
                  size="small"
                  icon={<ReloadOutlined />}
                  onClick={() => onRetry(message.id)}
                />
              </Tooltip>
            )}
          </div>
        )}
      </div>
    </div>
  );
};

// 流式回复期间父级 streamingContent 每个 token 都会变，导致 ChatRenderer 整体重渲染；
// 用 memo 挡住那些内容和回调引用都没变的历史消息，避免消息越多、流式打字时越卡。
export const MessageBubble = React.memo(MessageBubbleImpl);
