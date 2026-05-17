/**
 * useChat Hook (IPC 版本)
 * 通过 IPC 与 Electron 主进程通信
 */
import { useState, useCallback, useRef, useEffect } from 'react';
import {
  chatIPC,
  ChatMessage,
  SessionConfig,
  ContentPart,
  StreamChunkEvent,
  StreamToolEvent,
  StreamDoneEvent,
  StreamErrorEvent,
  generateId,
} from '../ipc';
import { createLogger } from '../../store/logger';

const logger = createLogger('useChatIPC');

export interface UseChatOptions {
  config?: SessionConfig;
  onError?: (error: Error) => void;
  onStreamStart?: () => void;
  onStreamEnd?: () => void;
  onToolCall?: (toolCall: { name: string; arguments: Record<string, unknown> }) => void;
}

export interface UseChatReturn {
  messages: ChatMessage[];
  isLoading: boolean;
  isStreaming: boolean;
  streamingContent: string;
  streamingReasoning: string;
  error: Error | null;
  sessionId: string;
  isReady: boolean;

  send: (content: string | ContentPart[]) => Promise<void>;
  sendStream: (content: string | ContentPart[], streamOpts?: { skipUserMessage?: boolean }) => Promise<void>;
  retry: (messageId: string) => Promise<void>;
  clear: () => void;
  stop: () => void;
  updateConfig: (config: Partial<SessionConfig>) => Promise<void>;
  loadSession: (sessionId: string) => Promise<void>;
  appendAssistantMessage: (content: string | ContentPart[]) => ChatMessage;
  appendUserMessage: (content: string | ContentPart[]) => ChatMessage;
  updateMessage: (id: string, updater: (msg: ChatMessage) => ChatMessage) => void;
  removeMessage: (id: string) => void;
  restoreMessages: (messages: ChatMessage[]) => void;
}

export function useChat(options: UseChatOptions = {}): UseChatReturn {
  const [sessionId, setSessionId] = useState<string>('');
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [isStreaming, setIsStreaming] = useState(false);
  const [streamingContent, setStreamingContent] = useState('');
  const [streamingReasoning, setStreamingReasoning] = useState('');
  const [error, setError] = useState<Error | null>(null);
  const [isReady, setIsReady] = useState(false);

  const currentSessionIdRef = useRef<string>('');
  const unsubscribersRef = useRef<Array<() => void>>([]);
  const configRef = useRef<SessionConfig | undefined>(options.config);

  // 更新 configRef
  useEffect(() => {
    configRef.current = options.config;
  }, [options.config]);

  // 初始化会话 - 需要存在可用的 LLM 配置引用或旧版 apiKey
  useEffect(() => {
    if (!chatIPC.isElectron()) {
      logger.warn('Chat IPC is only available in Electron environment');
      return;
    }

    // 如果已经有会话了，不重复创建
    if (currentSessionIdRef.current) {
      return;
    }

    if (!options.config?.llmProfileId && !options.config?.apiKey) {
      return;
    }

    const initSession = async () => {
      try {
        const session = await chatIPC.createSession(options.config);
        setSessionId(session.id);
        currentSessionIdRef.current = session.id;
        setIsReady(true);
      } catch (err) {
        logger.error('Failed to create chat session', err);
        setError(err instanceof Error ? err : new Error('Failed to create session'));
      }
    };

    initSession();

    return () => {
      // 清理会话
      if (currentSessionIdRef.current) {
        chatIPC.disposeSession(currentSessionIdRef.current).catch(err => logger.error('Failed to dispose session', err));
        currentSessionIdRef.current = '';
      }
      // 取消订阅
      unsubscribersRef.current.forEach(unsub => unsub());
      unsubscribersRef.current = [];
    };
  }, [options.config?.llmProfileId, options.config?.apiKey]);

  // 当配置变化时更新会话配置
  useEffect(() => {
    if (!isReady || !sessionId || !options.config) return;

    // 更新会话配置
    chatIPC.updateSessionConfig(sessionId, options.config).catch(err => {
      logger.error('Failed to update session config', err);
    });
  }, [isReady, sessionId, options.config?.modelProvider, options.config?.modelName, options.config?.apiKey, options.config?.baseUrl, options.config?.systemPrompt]);

  // 监听流式事件
  useEffect(() => {
    if (!chatIPC.isElectron()) return;

    const handleChunk = (_: any, data: StreamChunkEvent) => {
      if (data.sessionId !== currentSessionIdRef.current) return;

      setStreamingContent(prev => prev + data.delta);
      if (data.reasoning) {
        setStreamingReasoning(prev => prev + data.reasoning);
      }
    };

    const handleTool = (_: any, data: StreamToolEvent) => {
      if (data.sessionId !== currentSessionIdRef.current) return;

      options.onToolCall?.(data.toolCall);
    };

    const handleDone = (_: any, data: StreamDoneEvent) => {
      if (data.sessionId !== currentSessionIdRef.current) return;

      if (data.message) {
        setMessages(prev => [...prev, data.message!]);
      }

      setIsLoading(false);
      setIsStreaming(false);
      setStreamingContent('');
      setStreamingReasoning('');
      options.onStreamEnd?.();
    };

    const handleError = (_: any, data: StreamErrorEvent) => {
      if (data.sessionId !== currentSessionIdRef.current) return;

      const rawMessage = data?.error?.message;
      const err = new Error(typeof rawMessage === 'string' && rawMessage ? rawMessage : '会话流式响应出错');
      setError(err);
      options.onError?.(err);

      setIsLoading(false);
      setIsStreaming(false);
      setStreamingContent('');
      setStreamingReasoning('');
      options.onStreamEnd?.();
    };

    const unsub1 = chatIPC.onStreamChunk(handleChunk);
    const unsub2 = chatIPC.onStreamTool(handleTool);
    const unsub3 = chatIPC.onStreamDone(handleDone);
    const unsub4 = chatIPC.onStreamError(handleError);

    unsubscribersRef.current = [unsub1, unsub2, unsub3, unsub4];

    return () => {
      unsub1();
      unsub2();
      unsub3();
      unsub4();
    };
  }, [options.onError, options.onStreamEnd, options.onToolCall]);

  const send = useCallback(async (content: string | ContentPart[]) => {
    if (!sessionId || !isReady) return;

    setIsLoading(true);
    setError(null);

    // 乐观更新：添加用户消息
    const userMessage: ChatMessage = {
      id: generateId(),
      role: 'user',
      content,
      timestamp: Date.now(),
    };
    setMessages(prev => [...prev, userMessage]);

    try {
      const result = await chatIPC.sendMessage(sessionId, { role: 'user', content });
      if (result) {
        setMessages(prev => [...prev, result]);
      }
    } catch (err) {
      const error = err instanceof Error ? err : new Error('发送失败');
      setError(error);
      options.onError?.(error);
    } finally {
      setIsLoading(false);
    }
  }, [sessionId, isReady, options.onError]);

  const sendStream = useCallback(async (
    content: string | ContentPart[],
    streamOpts?: { skipUserMessage?: boolean },
  ) => {
    if (!sessionId || !isReady) return;

    setIsLoading(true);
    setIsStreaming(true);
    setStreamingContent('');
    setStreamingReasoning('');
    setError(null);
    options.onStreamStart?.();

    // 乐观更新：添加用户消息（调用方已显式 append 时跳过，避免重复）
    if (!streamOpts?.skipUserMessage) {
      const userMessage: ChatMessage = {
        id: generateId(),
        role: 'user',
        content,
        timestamp: Date.now(),
      };
      setMessages(prev => [...prev, userMessage]);
    }

    try {
      await chatIPC.sendMessageStream(sessionId, { role: 'user', content });
      // 流式响应通过事件回调处理
    } catch (err) {
      const error = err instanceof Error ? err : new Error('发送失败');
      setError(error);
      options.onError?.(error);
      setIsLoading(false);
      setIsStreaming(false);
      options.onStreamEnd?.();
    }
  }, [sessionId, isReady, options.onError, options.onStreamStart, options.onStreamEnd]);

  const retry = useCallback(async (messageId: string) => {
    const index = messages.findIndex(m => m.id === messageId);
    if (index === -1) return;

    // 找到用户消息
    let userMsgIndex = index;
    if (messages[index].role === 'assistant') {
      userMsgIndex = index - 1;
    }

    if (userMsgIndex < 0 || messages[userMsgIndex].role !== 'user') return;

    const userContent = messages[userMsgIndex].content;

    // 移除该消息及之后的所有消息
    setMessages(prev => prev.slice(0, userMsgIndex));

    // 重新发送
    await sendStream(userContent);
  }, [messages, sendStream]);

  const clear = useCallback(async () => {
    if (!sessionId) return;

    // 销毁旧会话，创建新会话
    try {
      await chatIPC.disposeSession(sessionId);
      const newSession = await chatIPC.createSession(configRef.current);
      setSessionId(newSession.id);
      currentSessionIdRef.current = newSession.id;
    } catch (err) {
      logger.error('Failed to clear session', err);
    }

    setMessages([]);
    setError(null);
    setStreamingContent('');
    setStreamingReasoning('');
  }, [sessionId]);

  const stop = useCallback(() => {
    if (sessionId) {
      chatIPC.cancelStream(sessionId).catch(err => logger.error('Failed to cancel stream', err));
    }
  }, [sessionId]);

  const updateConfig = useCallback(async (config: Partial<SessionConfig>) => {
    if (!sessionId) return;

    try {
      await chatIPC.updateSessionConfig(sessionId, config);
    } catch (err) {
      logger.error('Failed to update session config', err);
    }
  }, [sessionId]);

  const loadSession = useCallback(async (loadSessionId: string) => {
    try {
      const session = await chatIPC.getSession(loadSessionId);
      if (session) {
        // 销毁当前会话
        if (currentSessionIdRef.current && currentSessionIdRef.current !== loadSessionId) {
          await chatIPC.disposeSession(currentSessionIdRef.current);
        }

        setSessionId(session.id);
        currentSessionIdRef.current = session.id;
        setMessages(session.messages);
        setIsReady(true);
      }
    } catch (err) {
      logger.error('Failed to load session', err);
      setError(err instanceof Error ? err : new Error('Failed to load session'));
    }
  }, []);

  const appendAssistantMessage = useCallback((content: string | ContentPart[]): ChatMessage => {
    const message: ChatMessage = {
      id: generateId(),
      role: 'assistant',
      content,
      timestamp: Date.now(),
    };
    setMessages(prev => [...prev, message]);
    return message;
  }, []);

  const appendUserMessage = useCallback((content: string | ContentPart[]): ChatMessage => {
    const message: ChatMessage = {
      id: generateId(),
      role: 'user',
      content,
      timestamp: Date.now(),
    };
    setMessages(prev => [...prev, message]);
    return message;
  }, []);

  const updateMessage = useCallback((id: string, updater: (msg: ChatMessage) => ChatMessage) => {
    setMessages(prev => prev.map(msg => (msg.id === id ? updater(msg) : msg)));
  }, []);

  const removeMessage = useCallback((id: string) => {
    setMessages(prev => prev.filter(msg => msg.id !== id));
  }, []);

  /** 从历史持久化恢复消息列表（不影响 Electron 主进程的活会话） */
  const restoreMessages = useCallback((restored: ChatMessage[]) => {
    setMessages(restored);
    setError(null);
    setStreamingContent('');
    setStreamingReasoning('');
  }, []);

  return {
    messages,
    isLoading,
    isStreaming,
    streamingContent,
    streamingReasoning,
    error,
    sessionId,
    isReady,
    send,
    sendStream,
    retry,
    clear,
    stop,
    updateConfig,
    loadSession,
    appendAssistantMessage,
    appendUserMessage,
    updateMessage,
    removeMessage,
    restoreMessages,
  };
}

export default useChat;
