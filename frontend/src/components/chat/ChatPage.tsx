/**
 * 对话页面组件 (IPC 版本)
 * 通过 IPC 与 Electron 主进程通信
 */
import React, { useState, useEffect, useMemo, useCallback, useRef } from 'react';
import { message, Button, Tooltip, Spin } from 'antd';
import { ClearOutlined, HistoryOutlined, ApiOutlined } from '@ant-design/icons';
import { useTranslation } from 'react-i18next';
import { ChatRenderer } from '../../chat';
import { useChat, chatIPC } from '../../chat/ipc';
import type { SessionConfig, ContentPart, ChatMessage } from '../../chat/ipc';
import { loadSettings } from '../../store/globalStore';
import { useChatHistoryStore } from '../../store/chatHistoryStore';
import { saveMCPServers } from '../../store/settings/chatSettings';
import type { AppSettings } from '../../types';
import { ChatLayout } from './ChatLayout';
import { ChatComposer } from './ChatComposer';
import type { AttachmentFile } from './ChatComposer';
import {
  startChatMedia,
  uploadAttachmentImagesToHosting,
  extractChatImageMentionLabels,
  type ChatImageRef,
  type ChatMediaMode,
  type ChatMediaParams,
  type MediaResultMeta,
} from './chatMediaGeneration';
import { classifyChatIntent } from '../../services/chatIntentRouter';
import {
  pollChatMediaTask,
  recoverPendingChatTasks,
  type ChatTaskCancel,
} from '../../services/chatTaskRecovery';
import { persistChatMediaToLocal } from '../../services/chatMediaPersistence';
import { HistorySidebar } from './HistorySidebar';
import { MCPSettings } from './MCPSettings';
import type { MCPServerConfig } from '../../chat/ipc';
import { createLogger } from '../../store/logger';
import styles from './ChatPage.module.scss';
import {
  buildLLMConfigFromContext,
  listConfiguredModelSelectOptions,
  resolveConfiguredChannelModel,
  serializeMediaSelection,
} from '../../providers/channel/resolver';
import { getDurationSpecForITVSelection, type VideoDurationSpec } from '../../providers/itv/durationSpec';
import {
  buildChatSessionConfig,
  formatChatErrorMessage,
  resolveInitialChatLLMSelection,
} from './chatPageUtils';

const logger = createLogger('ChatPage');

export const ChatPage: React.FC = () => {
  const { t } = useTranslation();
  const [settings, setSettings] = useState<AppSettings | null>(null);
  const [llmOptions, setLlmOptions] = useState<ReturnType<typeof listConfiguredModelSelectOptions>>([]);
  const [selectedSelectionKey, setSelectedSelectionKey] = useState<string>('');
  const [showSidebar, setShowSidebar] = useState(true);
  const [showMcpSettings, setShowMcpSettings] = useState(false);
  const [mcpConfigs, setMcpConfigs] = useState<MCPServerConfig[]>([]);
  const [isConfigLoaded, setIsConfigLoaded] = useState(false);
  const [isGeneratingMedia, setIsGeneratingMedia] = useState(false);
  const [chatImageRefs, setChatImageRefs] = useState<ChatImageRef[]>([]);

  // 获取当前选中的 LLM 配置
  const selectedConfig = useMemo(() => {
    if (!settings || !selectedSelectionKey) return null;
    const context = resolveConfiguredChannelModel(settings, 'llm', selectedSelectionKey, 'llm.chat');
    return context ? buildLLMConfigFromContext(context) : null;
  }, [settings, selectedSelectionKey]);

  // 构建 Session 配置
  const sessionConfig = useMemo((): SessionConfig => (
    buildChatSessionConfig(selectedConfig)
  ), [selectedConfig]);

  // 使用 IPC 版本的 useChat
  const {
    messages,
    isLoading,
    isStreaming,
    streamingContent,
    streamingReasoning,
    isReady,
    sendStream,
    clear,
    stop,
    updateConfig,
    appendAssistantMessage,
    appendUserMessage,
    updateMessage,
    removeMessage,
    restoreMessages,
  } = useChat({
    config: sessionConfig,
    onError: (err) => {
      message.error(formatChatErrorMessage(err));
    },
  });

  // 加载配置
  useEffect(() => {
    const loadConfigs = async () => {
      try {
        const settings = await loadSettings();
        setSettings(settings);
        const options = listConfiguredModelSelectOptions(settings, 'llm', 'llm.chat');
        setLlmOptions(options);
        setMcpConfigs((settings as any).mcpServers || []);

        const activeSelection = resolveInitialChatLLMSelection(settings);
        const activeSelectionKey = serializeMediaSelection(activeSelection);
        if (activeSelectionKey) {
          setSelectedSelectionKey(activeSelectionKey);
        }

        setIsConfigLoaded(true);
      } catch (err) {
        logger.error('加载配置失败', err);
        setIsConfigLoaded(true);
      }
    };
    loadConfigs();
  }, []);

  // 连接 MCP 服务器
  useEffect(() => {
    if (!isReady || !chatIPC.isElectron()) return;

    const connectMCPServers = async () => {
      for (const config of mcpConfigs) {
        try {
          await chatIPC.mcp.connect(config);
        } catch (err) {
          logger.error(`连接 MCP 服务器 ${config.name} 失败`, err);
        }
      }
    };

    connectMCPServers();
  }, [isReady, mcpConfigs]);

  // 切换 LLM 配置
  const handleConfigChange = useCallback(async (selectionKey: string) => {
    setSelectedSelectionKey(selectionKey);
    const config = settings
      ? (() => {
          const context = resolveConfiguredChannelModel(settings, 'llm', selectionKey, 'llm.chat');
          return context ? buildLLMConfigFromContext(context) : null;
        })()
      : null;
    if (config && isReady) {
      try {
        await updateConfig(buildChatSessionConfig(config));
      } catch (err: unknown) {
        const errorMessage = formatChatErrorMessage(err);
        message.error(t('chat.configUpdateFailed', { error: errorMessage }));
      }
    }
  }, [isReady, settings, updateConfig, t]);

  const [ttiSelectionKey, setTtiSelectionKey] = useState<string | undefined>(undefined);
  const [itvSelectionKey, setItvSelectionKey] = useState<string | undefined>(undefined);

  // 把 settings.mediaDefaults 里的默认 tti / itv 选择灌进本地 state，作为初值
  useEffect(() => {
    if (!settings) return;
    setTtiSelectionKey(prev => prev ?? (settings.mediaDefaults?.tti ? serializeMediaSelection(settings.mediaDefaults.tti) : undefined));
    setItvSelectionKey(prev => prev ?? (settings.mediaDefaults?.itv ? serializeMediaSelection(settings.mediaDefaults.itv) : undefined));
  }, [settings]);

  const chatModelOptions = useMemo(() => (
    llmOptions.map(c => ({ value: c.value, label: `${c.channelLabel} / ${c.modelLabel}` }))
  ), [llmOptions]);

  const ttiModelOptions = useMemo(() => {
    if (!settings) return [] as { value: string; label: string }[];
    return listConfiguredModelSelectOptions(settings, 'tti', 'image.text-to-image').map(c => ({
      value: c.value,
      label: `${c.channelLabel} / ${c.modelLabel}`,
    }));
  }, [settings]);

  const itvModelOptions = useMemo(() => {
    if (!settings) return [] as { value: string; label: string }[];
    return listConfiguredModelSelectOptions(settings, 'itv', 'video.image-to-video').map(c => ({
      value: c.value,
      label: `${c.channelLabel} / ${c.modelLabel}`,
    }));
  }, [settings]);

  // 当前选中 ITV 模型的视频时长 spec（enum 或 range，从渠道能力订阅）
  const itvDurationSpec = useMemo<VideoDurationSpec | undefined>(() => {
    if (!settings || !itvSelectionKey) return undefined;
    const channels = (settings.channelConfigs ?? [])
      .filter(c => c.category === 'itv')
      .map(c => ({ id: c.id, providerType: c.providerType }));
    return getDurationSpecForITVSelection(itvSelectionKey, channels);
  }, [settings, itvSelectionKey]);

  // 当前选中 ITV 模型的 video.* capabilities（决定子模式 popover 列出哪几项）
  const itvCapabilities = useMemo<string[] | undefined>(() => {
    if (!settings || !itvSelectionKey) return undefined;
    const ctx = resolveConfiguredChannelModel(settings, 'itv', itvSelectionKey);
    return ctx?.model.capabilities.filter((c) => c.startsWith('video.'));
  }, [settings, itvSelectionKey]);

  // 选图后立即上传到图床，加进 chatImageRefs 并标记 pending=true（待跟随消息送出）
  const handleUploadImage = useCallback(async (file: File): Promise<void> => {
    try {
      const url = (await uploadAttachmentImagesToHosting([{
        id: `${Date.now()}-${Math.random().toString(36).slice(2)}`,
        file,
        type: 'image',
      } as AttachmentFile]))[0];
      if (!url) return;
      // 关键：用函数式 setter 取最新 prev.length，避免并发上传时所有闭包共用旧 length 导致全叫"图片1"
      setChatImageRefs(prev => {
        const number = prev.length + 1;
        const newRef: ChatImageRef = {
          id: `chat-image-${Date.now()}-${number}-${Math.random().toString(36).slice(2, 8)}`,
          label: `图片${number}`,
          source: url,
          remoteUrl: /^https?:\/\//i.test(url) ? url : undefined,
          mimeType: file.type,
          origin: 'upload',
          pending: true,
        };
        return [...prev, newRef];
      });
    } catch (err: unknown) {
      const errorMessage = err instanceof Error ? err.message : String(err);
      message.error(`图片上传失败：${errorMessage}`);
      throw err;
    }
  }, []);

  // 历史存储（提前到 polling/handleSend 之前，让所有 callback 闭包能拿到 currentSessionId）
  const {
    loadMessages: loadHistoryMessages,
    saveMessages,
    createSession: createHistorySession,
    currentSessionId,
    setCurrentSession,
    loadSessions: reloadSessionsList,
  } = useChatHistoryStore();

  // 用 ref 把 handleSend 暴露给前面定义的 handleMediaRegenerate（避免循环依赖）
  const handleSendRef = useRef<((text: string, mode?: ChatMediaMode, mediaParams?: ChatMediaParams) => Promise<void>) | null>(null);

  // 活跃的 chat 任务轮询（messageId → cancel）。session 切换 / 组件卸载时全部 cancel。
  const activePollsRef = useRef<Map<string, ChatTaskCancel>>(new Map());

  // 共用的 polling 回调写法：完成时改 metadata.mediaResult、清 activePolls 条目
  const startPollingForMessage = useCallback((messageId: string, meta: MediaResultMeta) => {
    if (!meta.taskId || !meta.taskKind || !meta.taskCapability) return;
    // 同一 messageId 已有轮询在跑则跳过
    if (activePollsRef.current.has(messageId)) return;
    const cancel = pollChatMediaTask({
      taskId: meta.taskId,
      taskKind: meta.taskKind,
      taskCapability: meta.taskCapability,
      modelSelectionKey: meta.modelSelectionKey,
      context: { sessionId: currentSessionId ?? undefined, messageId },
      callbacks: {
        onComplete: (result) => {
          activePollsRef.current.delete(messageId);
          // 把异步生图结果加到 @ 引用池（与 immediate 路径保持一致）
          if (result.images && result.images.length > 0) {
            setChatImageRefs(prev => [...prev, ...result.images!]);
          }
          updateMessage(messageId, (msg) => {
            const cur = (msg.metadata as { mediaResult?: MediaResultMeta } | undefined)?.mediaResult;
            if (!cur) return msg;
            return {
              ...msg,
              metadata: {
                ...(msg.metadata || {}),
                mediaResult: {
                  ...cur,
                  generating: false,
                  video: result.video ?? cur.video,
                  images: result.images && result.images.length > 0 ? result.images : cur.images,
                },
              },
            };
          });
        },
        onError: (errorMessage) => {
          activePollsRef.current.delete(messageId);
          updateMessage(messageId, (msg) => {
            const cur = (msg.metadata as { mediaResult?: MediaResultMeta } | undefined)?.mediaResult;
            if (!cur) return msg;
            return {
              ...msg,
              metadata: {
                ...(msg.metadata || {}),
                mediaResult: { ...cur, generating: false, error: errorMessage },
              },
            };
          });
        },
      },
    });
    activePollsRef.current.set(messageId, cancel);
  }, [updateMessage, currentSessionId]);

  // 组件卸载时取消所有活跃轮询
  useEffect(() => () => {
    activePollsRef.current.forEach(cancel => cancel());
    activePollsRef.current.clear();
  }, []);

  // 历史存储（提前到 handleSend 之前，让 handleSend 能在入口处主动建 session）
  // 发送消息
  const handleSend = useCallback(async (
    text: string,
    selectedMode: ChatMediaMode = 'chat',
    mediaParams: ChatMediaParams = {},
  ) => {
    // 诊断：handleSend 入口看到的所有参数 + 当前选中的模型 key
    logger.info('handleSend 入口', {
      text: text.slice(0, 80),
      selectedMode,
      mediaParams,
      ttiSelectionKey,
      itvSelectionKey,
      chatImageRefsCount: chatImageRefs.length,
      pendingImageRefsCount: chatImageRefs.filter(r => r.pending).length,
    });
    // 触发任何对话前确保有 currentSessionId，新对话则立即建一个，立即写入侧栏
    if (!currentSessionId) {
      const newId = createHistorySession();
      logger.info('handleSend: 创建新会话', { newId });
    }

    // 携带哪些图发送：
    //  - 文本里有 @ 引用 → 严格按 @ 出现顺序送（pending 忽略，用户的 @ 顺序就是 provider 接收顺序）
    //  - 文本无 @ → 送所有 pending（按缩略图区顺序）
    const pendingImageRefs = chatImageRefs.filter(r => r.pending);
    const mentionedLabels = extractChatImageMentionLabels(text);
    const mentionedRefs = mentionedLabels
      .map(label => chatImageRefs.find(r => r.label === label))
      .filter(Boolean) as ChatImageRef[];
    // 去重但保持出现顺序
    const seenIds = new Set<string>();
    const dedupKeepOrder = (arr: ChatImageRef[]) => arr.filter(r => {
      if (seenIds.has(r.id)) return false;
      seenIds.add(r.id);
      return true;
    });
    const refsToSend: ChatImageRef[] = mentionedRefs.length > 0
      ? dedupKeepOrder(mentionedRefs)
      : pendingImageRefs;

    // ★ 用户消息立即出现 — 不等任何路由 / IPC，先把消息塞进对话流
    const userParts: ContentPart[] = [];
    if (text) userParts.push({ type: 'text', text });
    refsToSend.forEach(ref => {
      userParts.push({ type: 'image', imageUrl: ref.source, mimeType: ref.mimeType });
    });
    const userContentForSend: string | ContentPart[] = userParts.length === 0
      ? ''
      : (userParts.length === 1 && userParts[0].type === 'text' ? userParts[0].text : userParts);
    if (userParts.length > 0) {
      appendUserMessage(userContentForSend);
    }
    // pending → 翻成已发送（仅 pending 那批；@ 引用的本来就 pending=false）
    setChatImageRefs(prev => prev.map(r => (r.pending ? { ...r, pending: false } : r)));

    // ReAct 意图路由：LLM 输出 thought + mode（用户能看到推理过程）
    // 传精确 imageCount（不只 boolean），让 LLM 区分 image-to-video（1 张）vs reference-to-video（多张）
    const imageCount = refsToSend.length;
    let inferredMode: ChatMediaMode;
    let routeThought: string | undefined;
    if (selectedMode !== 'chat') {
      inferredMode = selectedMode;
      routeThought = `用户显式选择 ${selectedMode} 模式`;
    } else if (selectedConfig) {
      const decision = await classifyChatIntent({ text, imageCount, llmConfig: selectedConfig });
      inferredMode = decision.mode;
      routeThought = decision.thought;
    } else {
      inferredMode = 'chat';
    }

    if (inferredMode !== 'chat') {
      // 当前选中的模型 label / selectionKey（用于 metadata）
      const isVideoMode = inferredMode === 'text-to-video'
        || inferredMode === 'image-to-video'
        || inferredMode === 'start-end-to-video'
        || inferredMode === 'reference-to-video';
      const modelLabel = isVideoMode
        ? itvModelOptions.find(o => o.value === itvSelectionKey)?.label
        : ttiModelOptions.find(o => o.value === ttiSelectionKey)?.label;
      const modelSelectionKey = isVideoMode ? itvSelectionKey : ttiSelectionKey;

      // 用户消息已在 handleSend 入口立即 append；这里只建 placeholder assistant
      // 占位 assistant 消息：用 metadata.mediaResult 标识，UI 走专用卡片渲染
      const initialMeta: MediaResultMeta = {
        kind: 'media-result',
        mode: inferredMode,
        prompt: text,
        modelLabel,
        modelSelectionKey,
        aspectRatio: mediaParams.aspectRatio,
        resolution: mediaParams.resolution,
        duration: mediaParams.duration,
        count: mediaParams.count,
        generating: true,
        sourceImageRefs: refsToSend.map(r => ({ ...r, pending: false })),
        thought: routeThought,
      };
      const placeholder = appendAssistantMessage('');
      updateMessage(placeholder.id, (msg) => ({
        ...msg,
        metadata: { ...(msg.metadata || {}), mediaResult: initialMeta },
      }));

      setIsGeneratingMedia(true);
      try {
        // 诊断：紧贴 startChatMedia 调用前打一次最终参数
        logger.info('startChatMedia 调用前', {
          mode: inferredMode,
          refsToSendCount: refsToSend.length,
          refsToSendLabels: refsToSend.map(r => r.label),
          refsToSendSourcesPreview: refsToSend.map(r => r.source.slice(0, 80)),
          ttiSelection: ttiSelectionKey,
          itvSelection: itvSelectionKey,
          mediaParams,
        });
        const started = await startChatMedia({
          text,
          attachments: [],
          mode: inferredMode,
          imageRefs: chatImageRefs,
          refsToSend, // ★ 把"本次精确携带的图"透传，确保 pending 即使没 @ 也送给 provider
          ttiSelection: ttiSelectionKey,
          itvSelection: itvSelectionKey,
          existingImageCount: chatImageRefs.length,
          mediaParams,
        });

        if (started.mode === 'immediate') {
          // 即使是 immediate，video URL 也可能需要鉴权（如 Koma 的 /v1/videos/*/content）
          // 把每个远程源都过一遍 persistChatMediaToLocal 转成 koma-local:// 本地播放
          // 关键：把 provider 返回的原始远程 URL 存到 remoteUrl 字段（落盘后 source 是本地路径，
          // 之后再次引用为参考图时优先用 remoteUrl，不必重新走图床上传）
          const localizedImages: ChatImageRef[] = [];
          for (const img of started.images) {
            const remoteUrl = img.remoteUrl || (/^https?:\/\//i.test(img.source) ? img.source : undefined);
            const localized = await persistChatMediaToLocal({
              remoteUrl: img.source,
              kind: 'image',
              modelSelectionKey: ttiSelectionKey,
              sessionId: currentSessionId ?? undefined,
              messageId: placeholder.id,
            });
            localizedImages.push({ ...img, source: localized, remoteUrl });
          }
          const localizedVideo = started.video
            ? await persistChatMediaToLocal({
                remoteUrl: started.video,
                kind: 'video',
                modelSelectionKey: itvSelectionKey,
                sessionId: currentSessionId ?? undefined,
                messageId: placeholder.id,
              })
            : undefined;

          if (localizedImages.length > 0) {
            setChatImageRefs(prev => [...prev, ...localizedImages]);
          }
          const finalMeta: MediaResultMeta = {
            ...initialMeta,
            generating: false,
            images: localizedImages,
            video: localizedVideo,
            taskKind: started.taskKind,
            taskCapability: started.taskCapability,
          };
          updateMessage(placeholder.id, (msg) => ({
            ...msg,
            metadata: { ...(msg.metadata || {}), mediaResult: finalMeta },
          }));
        } else {
          // async：把 taskId 和 polling 必需信息写进 metadata（落库），然后启动轮询
          const asyncMeta: MediaResultMeta = {
            ...initialMeta,
            generating: true,
            taskId: started.taskId,
            taskKind: started.taskKind,
            taskCapability: started.taskCapability,
            modelSelectionKey: started.modelSelectionKey ?? initialMeta.modelSelectionKey,
          };
          updateMessage(placeholder.id, (msg) => ({
            ...msg,
            metadata: { ...(msg.metadata || {}), mediaResult: asyncMeta },
          }));
          startPollingForMessage(placeholder.id, asyncMeta);
        }
      } catch (err: unknown) {
        const errorMessage = err instanceof Error ? err.message : String(err);
        message.error(`媒体生成失败：${errorMessage}`);
        const errMeta: MediaResultMeta = { ...initialMeta, generating: false, error: errorMessage };
        updateMessage(placeholder.id, (msg) => ({
          ...msg,
          metadata: { ...(msg.metadata || {}), mediaResult: errMeta },
        }));
      } finally {
        setIsGeneratingMedia(false);
      }
      return;
    }

    if (!isReady) {
      // 用户消息已经显示了，但 session 还没就绪 → assistant 加一条提示而不是 toast 后什么都不做
      appendAssistantMessage(t('chat.sessionNotReady') as string);
      return;
    }
    if (!selectedConfig) {
      appendAssistantMessage(t('chat.configLLMFirst') as string);
      return;
    }

    try {
      // 用户消息已在入口立即 appendUserMessage，这里只走流式（skipUserMessage 避免重复）
      await sendStream(userContentForSend, { skipUserMessage: true });
    } catch (err: unknown) {
      const errorMessage = formatChatErrorMessage(err);
      message.error(t('chat.sendFailed', { error: errorMessage }));
      logger.error('发送消息失败', err);
    }
  }, [appendAssistantMessage, appendUserMessage, chatImageRefs, isReady, itvSelectionKey, selectedConfig, sendStream, t, ttiSelectionKey, updateMessage, ttiModelOptions, itvModelOptions, startPollingForMessage]);

  // 把 handleSend 暴露到 ref 给前面定义的 handleMediaRegenerate 使用
  useEffect(() => {
    handleSendRef.current = handleSend;
  }, [handleSend]);

  // 加载历史会话
  const handleLoadSession = useCallback(async (historySessionId: string) => {
    try {
      const sessionData = await loadHistoryMessages(historySessionId);
      if (!sessionData) {
        logger.warn('加载历史会话：DB 中未找到，从侧栏移除该 ghost session', { sessionId: historySessionId });
        // 重新从 DB 拉一次 sessions 列表，把内存中残留的"未持久化"幽灵会话清掉
        await reloadSessionsList();
        message.error('该会话已不存在，已从列表清理');
        return;
      }
      logger.info('加载历史会话', {
        sessionId: historySessionId,
        title: sessionData.title,
        messageCount: sessionData.messages.length,
      });
      // 重启后处理 generating=true 的媒体卡片：
      //  - 有 taskId：保留 generating 状态，下面会启动 recoverPendingChatTasks 接续轮询
      //  - 无 taskId（旧数据）：转为 error 提示用户重新生成
      const recoveredMessages = sessionData.messages.map((msg) => {
        const meta = (msg.metadata as { mediaResult?: MediaResultMeta } | undefined)?.mediaResult;
        if (meta?.generating && !meta.taskId) {
          return {
            ...msg,
            metadata: {
              ...(msg.metadata || {}),
              mediaResult: {
                ...meta,
                generating: false,
                error: '任务被中断（缺少恢复信息），请使用"再次生成"重试',
              },
            },
          };
        }
        return msg;
      });
      // 切 session 前先取消旧 session 的所有活跃轮询
      activePollsRef.current.forEach(cancel => cancel());
      activePollsRef.current.clear();
      // 顺序：先标记当前会话，再灌入消息（避免后续 auto-save 因 sessionId 缺失重建）
      setCurrentSession(historySessionId);
      restoreMessages(recoveredMessages);
      // 接续未完成任务的轮询（异步，不 await）
      const cancels = recoverPendingChatTasks({
        messages: recoveredMessages,
        sessionId: historySessionId,
        updateMessage,
      });
      cancels.forEach((cancel, msgId) => activePollsRef.current.set(msgId, cancel));
      // 加载成功不弹 toast，避免打扰
    } catch (err) {
      logger.error('加载历史会话失败', err);
      message.error(t('chat.loadChatFailed'));
    }
  }, [loadHistoryMessages, restoreMessages, setCurrentSession, reloadSessionsList, updateMessage, t]);

  // 新建对话
  const handleNewChat = useCallback(async () => {
    try {
      const newSessionId = createHistorySession();
      setCurrentSession(newSessionId);
      await clear();
      message.success(t('chat.newChatCreated'));
    } catch (err: unknown) {
      const errorMessage = formatChatErrorMessage(err);
      message.error(t('chat.createChatFailed', { error: errorMessage }));
    }
  }, [createHistorySession, setCurrentSession, clear, t]);

  // 诊断：跟踪 messages 状态变化，便于排查"加载后不显示"问题
  useEffect(() => {
    logger.info('messages 状态', { count: messages.length, currentSessionId });
  }, [messages.length, currentSessionId]);

  // 保存当前会话：handleSend 入口已确保 currentSessionId 存在，这里只负责把 messages 落库。
  // 用 messages 引用比较去重（每次 setMessages 都会换引用；如果引用相同说明没实质变化）。
  // 注意：不能用 length+lastId 作签名 —— updateMessage 改 metadata 时这两者都不变，
  // 会导致媒体生成结果（generating→done）的更新被吞掉，重启后还是"正在生成..."状态。
  const lastSavedMessagesRef = useRef<ChatMessage[] | null>(null);
  useEffect(() => {
    if (messages.length === 0) return;
    if (!currentSessionId) return; // 等 handleSend 建好 session 再存
    if (lastSavedMessagesRef.current === messages) return; // 同一引用，跳过
    lastSavedMessagesRef.current = messages;
    void saveMessages(currentSessionId, messages);
  }, [messages, currentSessionId, saveMessages]);

  // MCP 配置保存
  const handleSaveMcpConfigs = useCallback(async (configs: MCPServerConfig[]) => {
    try {
      setMcpConfigs(configs);
      await saveMCPServers(configs);

      // 重新连接 MCP 服务器
      if (chatIPC.isElectron()) {
        // 断开所有现有连接
        const { connections } = await chatIPC.mcp.list();
        for (const conn of connections) {
          await chatIPC.mcp.disconnect(conn.name);
        }
        // 连接新配置
        for (const config of configs) {
          try {
            await chatIPC.mcp.connect(config);
          } catch (err) {
            logger.error(`连接 MCP 服务器 ${config.name} 失败`, err);
          }
        }
      }
    } catch (err: unknown) {
      const errorMessage = formatChatErrorMessage(err);
      message.error(t('chat.mcpSaveFailed', { error: errorMessage }));
      logger.error('保存 MCP 配置失败', err);
    }
  }, [t]);

  // 切换 pending：只是"是否带到下次发送"，仍保留在 @ 引用池里
  const handleToggleImageRefPending = useCallback((id: string) => {
    setChatImageRefs(prev => prev.map(ref => (ref.id === id ? { ...ref, pending: !ref.pending } : ref)));
  }, []);

  // 真删除：从 @ 引用池移除（缩略图也消失，下次也不能 @）
  const handleDeleteImageRef = useCallback((id: string) => {
    setChatImageRefs(prev => prev.filter(ref => ref.id !== id));
  }, []);

  // 重新编辑 / 再次生成 / 删除批次 — 回填或直接触发
  const [composerSeed, setComposerSeed] = useState<{
    seedAt: number;
    text: string;
    mode: ChatMediaMode;
    aspectRatio?: string;
    resolution?: string;
    duration?: number;
    count?: number;
  } | null>(null);

  const handleMediaReedit = useCallback((messageId: string) => {
    const msg = messages.find(m => m.id === messageId);
    const meta = (msg?.metadata as { mediaResult?: MediaResultMeta } | undefined)?.mediaResult;
    if (!meta) return;
    // 恢复模型选择
    if (meta.modelSelectionKey) {
      const isVideoMeta = meta.mode === 'text-to-video'
        || meta.mode === 'image-to-video'
        || meta.mode === 'start-end-to-video'
        || meta.mode === 'reference-to-video';
      if (isVideoMeta) setItvSelectionKey(meta.modelSelectionKey);
      else setTtiSelectionKey(meta.modelSelectionKey);
    }
    // 把源图重新挂回 pending（若已经在 refs 里则不重复）
    if (meta.sourceImageRefs?.length) {
      setChatImageRefs(prev => {
        const existing = new Set(prev.map(r => r.id));
        const restored = meta.sourceImageRefs!
          .filter(r => !existing.has(r.id))
          .map(r => ({ ...r, pending: true }));
        return [...prev, ...restored];
      });
    }
    // 触发 ChatComposer 应用 seed
    setComposerSeed({
      seedAt: Date.now(),
      text: meta.prompt,
      mode: meta.mode,
      aspectRatio: meta.aspectRatio,
      resolution: meta.resolution,
      duration: meta.duration,
      count: meta.count,
    });
  }, [messages]);

  const handleMediaRegenerate = useCallback(async (messageId: string) => {
    const msg = messages.find(m => m.id === messageId);
    const meta = (msg?.metadata as { mediaResult?: MediaResultMeta } | undefined)?.mediaResult;
    if (!meta) return;
    if (meta.sourceImageRefs?.length) {
      setChatImageRefs(prev => {
        const existing = new Set(prev.map(r => r.id));
        const restored = meta.sourceImageRefs!
          .filter(r => !existing.has(r.id))
          .map(r => ({ ...r, pending: true }));
        return [...prev, ...restored];
      });
    }
    // 直接触发一次新生成（不改顶部模型选择）
    setTimeout(() => {
      void handleSendRef.current?.(meta.prompt, meta.mode, {
        aspectRatio: meta.aspectRatio,
        resolution: meta.resolution,
        duration: meta.duration,
        count: meta.count,
      });
    }, 0);
  }, [messages]);

  const handleMediaDelete = useCallback((messageId: string) => {
    removeMessage(messageId);
  }, [removeMessage]);

  /**
   * 综合"停止生成"：
   *  1) 取消 chat 流式 IPC（useChat.stop）
   *  2) 取消所有活跃的媒体轮询（activePolls）
   *  3) 把对话中所有 generating=true 的占位卡片标记为"已取消"
   *  4) 复位 isGeneratingMedia
   */
  const handleStop = useCallback(() => {
    // 1) 取消 chat 流式
    stop();
    // 2) 取消所有 polling
    activePollsRef.current.forEach(cancel => cancel());
    activePollsRef.current.clear();
    // 3) 找到所有还在 generating 的媒体卡片，标 error
    messages.forEach(msg => {
      const m = (msg.metadata as { mediaResult?: MediaResultMeta } | undefined)?.mediaResult;
      if (m?.generating) {
        updateMessage(msg.id, (curMsg) => {
          const cur = (curMsg.metadata as { mediaResult?: MediaResultMeta } | undefined)?.mediaResult;
          if (!cur) return curMsg;
          return {
            ...curMsg,
            metadata: {
              ...(curMsg.metadata || {}),
              mediaResult: { ...cur, generating: false, error: '已取消' },
            },
          };
        });
      }
    });
    // 4) 复位
    setIsGeneratingMedia(false);
  }, [stop, messages, updateMessage]);

  // 把生成结果作为参考图加到下次输入（pending=true）
  const handleMediaUseAsReference = useCallback((_messageId: string, images: ChatImageRef[]) => {
    if (!images.length) return;
    setChatImageRefs(prev => {
      const map = new Map(prev.map(r => [r.id, r]));
      images.forEach(img => {
        if (map.has(img.id)) {
          map.set(img.id, { ...map.get(img.id)!, pending: true });
        } else {
          map.set(img.id, { ...img, pending: true });
        }
      });
      return Array.from(map.values());
    });
    message.success(`已添加 ${images.length} 张作为参考图`);
  }, []);

  // 删除已加入对话的图/视频/文件 part
  const handleRemoveContentPart = useCallback((messageId: string, partIndex: number) => {
    updateMessage(messageId, (msg) => {
      if (typeof msg.content === 'string') return msg;
      const nextContent = msg.content.filter((_, idx) => idx !== partIndex);
      return { ...msg, content: nextContent };
    });
  }, [updateMessage]);

  // 加载中显示
  if (!isConfigLoaded) {
    return (
      <div className={`${styles.container} ${styles.loadingContainer}`}>
        <Spin description={t('chat.loadingConfig')} />
      </div>
    );
  }

  // 工具栏：模型选择已下沉到输入框，这里只保留侧栏切换 / MCP / 清空
  const toolbar = (
    <div className={styles.toolbar}>
      <div className={styles.toolbarLeft}>
        <Tooltip title={showSidebar ? t('chat.hideHistory') : t('chat.showHistory')}>
          <Button
            type="text"
            icon={<HistoryOutlined />}
            onClick={() => setShowSidebar(!showSidebar)}
          />
        </Tooltip>
        {!isReady && <Spin size="small" className={styles.readySpinner} />}
      </div>
      <div className={styles.toolbarRight}>
        <Tooltip title={t('chat.mcpConfig')}>
          <Button
            type="text"
            icon={<ApiOutlined />}
            onClick={() => setShowMcpSettings(true)}
          />
        </Tooltip>
        <Tooltip title={t('chat.clearChat')}>
          <Button
            type="text"
            icon={<ClearOutlined />}
            onClick={async () => {
              try {
                await clear();
                message.success(t('chat.chatCleared'));
              } catch (err: unknown) {
                const errorMessage = formatChatErrorMessage(err);
                message.error(t('chat.clearFailed', { error: errorMessage }));
              }
            }}
            disabled={messages.length === 0}
          />
        </Tooltip>
      </div>
    </div>
  );

  // 消息列表
  const messageList = (
    <ChatRenderer
      messages={messages}
      streaming={isStreaming}
      streamingContent={streamingContent}
      streamingReasoning={streamingReasoning}
      emptyText={llmOptions.length === 0 ? t('chat.noLLMConfig') : t('chat.startChat')}
      onRemoveContentPart={handleRemoveContentPart}
      onMediaReedit={handleMediaReedit}
      onMediaRegenerate={handleMediaRegenerate}
      onMediaDelete={handleMediaDelete}
      onMediaUseAsReference={handleMediaUseAsReference}
    />
  );

  // 输入组件
  const composer = (
    <ChatComposer
      onUploadImage={handleUploadImage}
      onSend={handleSend}
      onStop={handleStop}
      isLoading={isLoading || isGeneratingMedia}
      isStreaming={isStreaming || isGeneratingMedia}
      disabled={!isReady || !selectedConfig || isGeneratingMedia}
      imageRefs={chatImageRefs}
      onTogglePending={handleToggleImageRefPending}
      onDeleteImageRef={handleDeleteImageRef}
      chatModelOptions={chatModelOptions}
      chatModelValue={selectedSelectionKey || undefined}
      onChatModelChange={handleConfigChange}
      ttiModelOptions={ttiModelOptions}
      ttiModelValue={ttiSelectionKey}
      onTtiModelChange={setTtiSelectionKey}
      itvModelOptions={itvModelOptions}
      itvModelValue={itvSelectionKey}
      onItvModelChange={setItvSelectionKey}
      itvDurationSpec={itvDurationSpec}
      itvCapabilities={itvCapabilities}
      seed={composerSeed}
    />
  );

  // 侧边栏
  const sidebar = showSidebar ? (
    <HistorySidebar
      currentSessionId={currentSessionId}
      onSelectSession={handleLoadSession}
      onNewChat={handleNewChat}
    />
  ) : undefined;

  return (
    <div className={styles.container}>
      <ChatLayout
        hasMessages={messages.length > 0}
        sidebar={sidebar}
        toolbar={toolbar}
        settingsPanel={null}
        messageList={messageList}
        composer={composer}
      />

      {/* MCP 配置弹窗 */}
      <MCPSettings
        visible={showMcpSettings}
        onClose={() => setShowMcpSettings(false)}
        configs={mcpConfigs}
        onSave={handleSaveMcpConfigs}
      />
    </div>
  );
};

export default ChatPage;
