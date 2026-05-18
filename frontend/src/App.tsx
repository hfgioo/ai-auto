import React, { useState, useEffect, useCallback, useMemo, useRef, Suspense, lazy } from 'react';
import { Project, ScriptAnalysisResult, EditorStep, AppSettings, Episode, EpisodeStepProgress, AsyncTask } from './types';
import { ProjectList, CreateProjectModal, ProjectSettingsModal } from './components/project';
import type { MentionItem } from './editor';
import { getCharacterCostumePhotoSource } from './utils/mediaSelectors';
import { getMediaAssetDisplaySource } from './types';
import { WindowControls } from './components/common';
import { ErrorBoundary } from './components/common';
import { TaskStatusBar } from './components/common/TaskStatusBar';
import { Sidebar } from './components/common/Sidebar';
import type { AppView } from './components/common/Sidebar';
import { useProjects } from './hooks/useProjects';
import { useTaskTransitions } from './hooks';
import { TaskManager } from './services/TaskManager';
import { registerMediaPollFulfillers } from './services/mediaPollFulfillers';
import { registerAnalysisFulfillers } from './services/analysisFulfillers';
import {
  deletePendingMediaTasks,
  failPendingMediaTasks,
  inspectPendingMediaTasks,
  recoverProjectPendingMediaTasks,
  setCurrentProject,
  USER_INTERRUPTED_REASON,
} from './store/projectOpenService';
import { loadCharacters, loadScenes, loadProps, loadShots, loadEpisodeShots, saveEpisode, createEpisode } from './store/projectStore';
import { Spin, App as AntApp, Button } from 'antd';
import {
  DEV_TEST_PROJECT,
  DEV_TEST_ANALYSIS,
  DEFAULT_SCRIPT,
  DEFAULT_SETTINGS,
  formatTimeAgo,
} from './constants/appConstants';
import { getThumbnailUrl } from './constants/dimensions';
import { createLogger } from './store/logger';
import { loadSettings } from './store/globalStore';
import { listEditorStepIds } from './workflow/editorStepRegistry';
import { electronService } from './services/electronService';
import { resolveConfiguredChannelModel, serializeMediaSelection } from './providers/channel/resolver';
import {
  getDurationSpecForModel,
  getDurationSpecForProviderType,
} from './providers/itv/durationSpec';

const logger = createLogger('App');

type PendingMediaTaskPromptState = {
  projectId: string;
  tasks: AsyncTask[];
};

type PendingMediaTaskAction = 'recover' | 'fail' | 'delete';

const MEDIA_TASK_TYPE_LABELS: Record<AsyncTask['type'], string> = {
  tti: '图片生成',
  itv: '图生视频',
  tts: '语音生成',
  'character-extraction': '角色提取',
};

function buildPendingMediaTaskSignature(projectId: string, tasks: AsyncTask[]): string {
  const taskIds = tasks.map(task => task.id).sort().join(',');
  return `${projectId}:${taskIds}`;
}

function summarizePendingMediaTasks(tasks: AsyncTask[]): string {
  const counts = new Map<string, number>();
  for (const task of tasks) {
    const label = MEDIA_TASK_TYPE_LABELS[task.type] || '媒体任务';
    counts.set(label, (counts.get(label) || 0) + 1);
  }
  return Array.from(counts.entries())
    .map(([label, count]) => `${count} 个${label}`)
    .join('、');
}

// 懒加载重型组件
const EditorView = lazy(() => import('./components/editor/EditorView').then(m => ({ default: m.EditorView })));
const SettingsPage = lazy(() => import('./components/settings').then(m => ({ default: m.SettingsPage })));
const PluginManager = lazy(() => import('./components/plugins').then(m => ({ default: m.PluginManager })));
const PluginHost = lazy(() => import('./components/plugins').then(m => ({ default: m.PluginHost })));
const ChatPage = lazy(() => import('./components/chat').then(m => ({ default: m.ChatPage })));

// 加载中占位组件
const ViewLoading: React.FC<{ tip?: string }> = ({ tip = '加载中...' }) => (
  <div className="flex h-full items-center justify-center whitespace-nowrap bg-bg-app">
    <Spin size="large" description={tip}><div className="p-12" /></Spin>
  </div>
);

function isDisplayableProject(project: unknown): project is NonNullable<ReturnType<typeof useProjects>['projects'][number]> {
  if (!project || typeof project !== 'object') return false;
  const meta = project as { id?: unknown; title?: unknown; genre?: unknown; mode?: unknown; updatedAt?: unknown };
  return (
    typeof meta.id === 'string' &&
    meta.id.length > 0 &&
    typeof meta.title === 'string' &&
    typeof meta.genre === 'string' &&
    (meta.mode === 'drama' || meta.mode === 'narration') &&
    typeof meta.updatedAt === 'number'
  );
}

const AppContent: React.FC = () => {
  const { message } = AntApp.useApp();
  const { modal } = AntApp.useApp();

  // 开发模式检测
  const urlParams = new URLSearchParams(window.location.search);
  const devMode = urlParams.get('dev');
  const isVideoDevMode = devMode === 'video';

  // 项目管理 Hook
  const {
    projects,
    loading: projectsLoading,
    createProject: createProjectAPI,
    deleteProject: deleteProjectAPI,
    updateProject: updateProjectAPI,
  } = useProjects();

  const [view, setView] = useState<AppView>(isVideoDevMode ? 'editor' : 'projects');
  const [activeProject, setActiveProject] = useState<Project | null>(isVideoDevMode ? DEV_TEST_PROJECT : null);
  const [editorStep, setEditorStep] = useState<EditorStep>(isVideoDevMode ? 'video' : 'script');
  const [activeEpisode, setActiveEpisode] = useState<Episode | null>(null);
  const [stepProgress, setStepProgress] = useState<EpisodeStepProgress>({
    assets: 'pending', storyboard: 'pending', video: 'pending',
  });
  const [appSettings, setAppSettings] = useState<AppSettings>(DEFAULT_SETTINGS);
  const [isCreateModalOpen, setIsCreateModalOpen] = useState(false);
  const [isProjectSettingsOpen, setIsProjectSettingsOpen] = useState(false);
  const [scriptText, setScriptText] = useState(DEFAULT_SCRIPT);
  const [analysisData, setAnalysisData] = useState<ScriptAnalysisResult | null>(isVideoDevMode ? DEV_TEST_ANALYSIS : null);
  const promptedPendingMediaSignaturesRef = useRef<Set<string>>(new Set());
  const [pendingMediaPrompt, setPendingMediaPrompt] = useState<PendingMediaTaskPromptState | null>(null);
  const [pendingMediaAction, setPendingMediaAction] = useState<PendingMediaTaskAction | null>(null);
  const [taskStatusRefreshKey, setTaskStatusRefreshKey] = useState(0);

  const reloadSettings = useCallback(async () => {
    try {
      const nextSettings = await loadSettings();
      setAppSettings(nextSettings);
    } catch (error) {
      logger.error('加载全局设置失败', error);
    }
  }, []);

  useEffect(() => {
    void reloadSettings();
  }, [reloadSettings]);

  // 当前项目 ITV 渠道的时长规格 — 传给 ProjectSettingsModal 让"视频提示词"档位 checkbox
  // 把不在 spec 范围内的档位灰显（model 优先 > providerType > default）
  const projectItvDurationSpec = useMemo(() => {
    if (!activeProject) return undefined;
    const itvSelection = serializeMediaSelection(activeProject.mediaSelections?.itv);
    const ctx = resolveConfiguredChannelModel(appSettings, 'itv', itvSelection);
    return (
      getDurationSpecForModel(ctx?.model.id)
      ?? getDurationSpecForProviderType(ctx?.channelConfig.providerType)
    );
  }, [activeProject, appSettings]);

  // 注册 main → renderer 反向调用的 fulfillers：
  //   media:* 由 main 主导媒体轮询 → renderer 调原 provider + 落盘
  //   analysis:* 由 main 主导父任务（限流 + 取消） → renderer 跑 LLM closures
  useEffect(() => {
    registerMediaPollFulfillers();
    registerAnalysisFulfillers();
  }, []);

  // 启动时检测旧 ~/.koma 数据是否需要迁移到新业务根（Windows 安装版改了路径才需要）
  // 仅提示一次：本会话内已询问过就不再问。用户选"忽略"则永久跳过（写 localStorage flag）
  useEffect(() => {
    if (!electronService.isElectron()) return;
    const SKIP_KEY = 'koma:skipLegacyDataMigration';
    if (localStorage.getItem(SKIP_KEY) === '1') return;

    let cancelled = false;
    (async () => {
      try {
        const info = await electronService.app.checkLegacyDataMigration();
        if (cancelled || !info.needsMigration) return;
        modal.confirm({
          title: '检测到旧版本数据',
          content: (
            <div>
              <div style={{ marginBottom: 8 }}>
                你的旧数据在：<code style={{ background: 'var(--token-bg-elevated)', padding: '1px 4px', borderRadius: 3 }}>{info.oldPath}</code>
              </div>
              <div style={{ marginBottom: 8 }}>
                新数据目录在：<code style={{ background: 'var(--token-bg-elevated)', padding: '1px 4px', borderRadius: 3 }}>{info.newPath}</code>
              </div>
              <div style={{ color: 'var(--token-text-secondary)' }}>
                这次更新后数据存放位置变了。新位置是空的，旧数据保留在原位。
                你可以手动把旧目录里的内容（projects/ settings.db plugins-runtime/ 等）整个拷贝到新目录。
              </div>
              <div style={{ marginTop: 8, color: 'var(--token-status-warning)', fontSize: 12 }}>
                注意：settings.db 里 apiKey 是按当前 Windows 用户加密的，跨用户复制后需要重新填。
              </div>
            </div>
          ),
          okText: '我知道了',
          cancelText: '不再提示',
          onOk: () => undefined,
          onCancel: () => {
            localStorage.setItem(SKIP_KEY, '1');
          },
        });
      } catch (err) {
        logger.warn('checkLegacyDataMigration failed', err);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [modal]);

  // 初始化 TaskManager，并同步当前项目上下文
  useEffect(() => {
    if (activeProject) {
      setCurrentProject(activeProject.id);
      TaskManager.initialize(activeProject.id).catch(err => {
        logger.error('TaskManager 初始化失败', err);
      });
    } else {
      setCurrentProject(null);
    }

    return () => {
      TaskManager.dispose();
      setCurrentProject(null);
    };
  }, [activeProject?.id]);

  // 启动/激活项目时检查未完成媒体任务，由用户决定是否恢复
  useEffect(() => {
    if (!activeProject) return;

    let disposed = false;
    const projectId = activeProject.id;

    inspectPendingMediaTasks(projectId)
      .then(tasks => {
        if (disposed || tasks.length === 0) return;

        const signature = buildPendingMediaTaskSignature(projectId, tasks);
        if (promptedPendingMediaSignaturesRef.current.has(signature)) return;

        promptedPendingMediaSignaturesRef.current.add(signature);
        setPendingMediaPrompt({ projectId, tasks });
      })
      .catch(err => {
        logger.error('检查未完成媒体任务失败', err);
      });

    return () => {
      disposed = true;
    };
  }, [activeProject?.id]);

  // 从存储加载分析数据
  const loadAnalysisData = useCallback(async (projectId: string) => {
    try {
      const [characters, scenes, props, shots] = await Promise.all([
        loadCharacters(projectId), loadScenes(projectId), loadProps(projectId), loadShots(projectId),
      ]);
      if (characters.length > 0 || scenes.length > 0 || shots.length > 0) {
        setAnalysisData({ characters, scenes, props, shots });
      }
    } catch (err) {
      logger.error('加载分析数据失败', err);
    }
  }, []);

  // mentionItems
  const mentionItems: MentionItem[] = useMemo(() => {
    const items: MentionItem[] = [];
    const characters = Array.isArray(analysisData?.characters) ? analysisData!.characters.filter(Boolean) : [];
    const scenes = Array.isArray(analysisData?.scenes) ? analysisData!.scenes.filter(Boolean) : [];
    const props = Array.isArray(analysisData?.props) ? analysisData!.props.filter(Boolean) : [];

    // 统一：编辑器里 @mention 只使用项目内资产 ID；高亮/补全覆盖角色/场景/道具。
    for (const char of characters) {
      items.push({
        id: char.id,
        type: 'char' as const,
        name: char.name,
        description: char.prompt,
        previewImage: getCharacterCostumePhotoSource(char),
      });
    }
    for (const scene of scenes) {
      items.push({
        id: scene.id,
        type: 'scene' as const,
        name: scene.name,
        description: scene.prompt,
        previewImage: getMediaAssetDisplaySource(scene.media?.previewImage),
      });
    }
    for (const prop of props) {
      items.push({
        id: prop.id,
        type: 'prop' as const,
        name: prop.name,
        description: prop.prompt,
        previewImage: getMediaAssetDisplaySource(prop.media?.previewImage),
      });
    }

    return items;
  }, [analysisData?.characters, analysisData?.scenes, analysisData?.props]);

  // 监听任务完成（edge-triggered 转换事件，避免 hydrate 时已 completed 的旧任务再次触发）
  useTaskTransitions(
    {
      scope: activeProject ? `project:${activeProject.id}` : undefined,
      type: 'script-analysis',
      to: ['completed'],
    },
    () => {
      if (!activeProject) return;
      message.success('剧本解析完成');
      loadAnalysisData(activeProject.id);
    }
  );

  // 进入编辑器视图时加载数据
  useEffect(() => {
    if (view === 'editor' && activeProject && !isVideoDevMode) {
      loadAnalysisData(activeProject.id);
    }
  }, [view, activeProject?.id, isVideoDevMode, loadAnalysisData]);

  // 切换到视频步骤时加载 shots
  useEffect(() => {
    if (editorStep === 'video' && activeProject && activeEpisode && !isVideoDevMode) {
      loadEpisodeShots(activeProject.id, activeEpisode.id).then(shots => {
        if (shots.length > 0) {
          setAnalysisData(prev => ({
            characters: prev?.characters || [], scenes: prev?.scenes || [],
            props: prev?.props || [], shots,
          }));
        }
      }).catch(err => {
        logger.error('加载剧集镜头失败', err);
      });
    }
  }, [editorStep, activeProject?.id, activeEpisode?.id, isVideoDevMode]);

  // 转换项目显示格式
  const displayProjects: Project[] = projects
    .filter(isDisplayableProject)
    .map(p => ({
    id: p.id, title: p.title, genre: p.genre, mode: p.mode,
    episodes: p.episodes ?? 0, lastEdited: formatTimeAgo(p.updatedAt),
    thumbnail: p.thumbnail || getThumbnailUrl(p.id),
    status: p.status || 'script',
    mediaSelections: p.mediaSelections,
    aspectRatio: p.aspectRatio,
    stylePresetId: p.stylePresetId,
    styleSnapshot: p.styleSnapshot,
    theme: p.theme,
    stylePrompt: p.stylePrompt,
  }));

  const handleCreateProject = async (data: {
    title: string;
    mode: 'drama' | 'narration';
    aspectRatio: '16:9' | '9:16';
    stylePresetId: string;
    scriptText?: string;
  }) => {
    try {
      const created = await createProjectAPI({
        title: data.title,
        mode: data.mode,
        genre: data.mode === 'drama' ? '剧情' : '解说',
        aspectRatio: data.aspectRatio,
        stylePresetId: data.stylePresetId,
      });
      const newProject: Project = {
        id: created.id, title: created.title, genre: created.genre, mode: created.mode,
        episodes: created.episodes || 1, lastEdited: '刚刚',
        thumbnail: created.thumbnail || getThumbnailUrl(created.id),
        status: created.status || 'script',
        aspectRatio: created.aspectRatio || data.aspectRatio,
        stylePresetId: created.stylePresetId,
        styleSnapshot: created.styleSnapshot,
        theme: created.theme,
        stylePrompt: created.stylePrompt,
      };

      // 用户在创建表单里粘贴了剧本 → 自动创建第 1 集，把剧本写入；
      // 不传则保持原有行为：用户进入空项目自行新建剧集
      let firstEpisode: Episode | null = null;
      const scriptText = data.scriptText?.trim() || '';
      if (scriptText) {
        try {
          firstEpisode = await createEpisode(created.id, {
            number: 1,
            title: '第 1 集',
            scriptText,
            status: 'script',
          });
        } catch (epErr: unknown) {
          // 项目本身已建成功；剧集失败不阻塞用户进入编辑器（手动添加即可）
          logger.error('导入剧本时创建第 1 集失败', epErr);
          message.warning('已创建项目，但导入剧本失败，请手动添加剧集');
        }
      }

      setActiveProject(newProject);
      setActiveEpisode(firstEpisode);
      setEditorStep('script');
      setStepProgress({ assets: 'pending', storyboard: 'pending', video: 'pending' });
      setView('editor');
      setScriptText(firstEpisode?.scriptText || '');
      setAnalysisData(null);
      setIsCreateModalOpen(false);
      message.success(firstEpisode ? '项目已创建，剧本已导入到第 1 集' : '项目创建成功');
    } catch (err: any) {
      message.error(err.message || '创建项目失败');
    }
  };

  const handleSelectProject = (id: string) => {
    const proj = displayProjects.find(p => p.id === id);
    if (proj) {
      setActiveProject(proj);
      setActiveEpisode(null);
      setEditorStep('script');
      setStepProgress({ assets: 'pending', storyboard: 'pending', video: 'pending' });
      setView('editor');
      setScriptText('');
      setAnalysisData(null);
    }
  };

  // TODO(strict-cleanup): handleEnterEpisode was defined but never wired up — preserved
  // as a comment in case it needs to be wired into the episode-editor entry refactor.
  // (Was: handleEnterEpisode(episode, options) — calls loadEpisode + setActiveEpisode + setView('editor') + setStepProgress + setEditorStep + setScriptText + setAnalysisData(null))

  const markStepCompleted = useCallback((step: EditorStep) => {
    setStepProgress(prev => {
      const updated = { ...prev, [step]: 'completed' as const };
      if (activeProject && activeEpisode) {
        setActiveEpisode({ ...activeEpisode, stepProgress: updated });
        saveEpisode(activeProject.id, activeEpisode.id, { stepProgress: updated }).catch(err => logger.error('保存剧集失败', err));
      }
      return updated;
    });
  }, [activeProject, activeEpisode]);

  const handleStepChangeWithMark = useCallback((targetStep: EditorStep) => {
    const stepOrder = listEditorStepIds();
    const currentIndex = stepOrder.indexOf(editorStep);
    const targetIndex = stepOrder.indexOf(targetStep);
    if (targetIndex > currentIndex) {
      markStepCompleted(editorStep);
    }
    setEditorStep(targetStep);
  }, [editorStep, markStepCompleted]);

  const handleDeleteProject = async (id: string) => {
    try {
      await deleteProjectAPI(id);
      message.success('项目已删除');
    } catch (err: any) {
      message.error(err.message || '删除项目失败');
    }
  };

  const handleProjectSettingsSave = async (updates: Partial<Project>) => {
    if (!activeProject) return;
    try {
      await updateProjectAPI(activeProject.id, updates);
      setActiveProject({ ...activeProject, ...updates });
      message.success('项目设置已保存');
    } catch (err: any) {
      message.error(err.message || '保存失败');
    }
  };

  const refreshTaskStatusBar = useCallback(() => {
    setTaskStatusRefreshKey(key => key + 1);
  }, []);

  const handleRecoverPendingMediaTasks = useCallback(() => {
    if (!pendingMediaPrompt || pendingMediaAction) return;

    const { projectId, tasks } = pendingMediaPrompt;
    setPendingMediaAction('recover');
    setPendingMediaPrompt(null);
    setPendingMediaAction(null);
    message.loading(`正在后台恢复 ${tasks.length} 个未完成媒体任务...`);

    void recoverProjectPendingMediaTasks(projectId)
      .then(result => {
        refreshTaskStatusBar();
        if (result.recovered > 0) {
          message.success(`已恢复 ${result.recovered} 个媒体任务`);
        } else if (result.failed > 0) {
          message.warning(`媒体任务恢复完成，${result.failed} 个任务恢复失败`);
        } else {
          message.info('没有需要恢复的媒体任务');
        }
      })
      .catch(err => {
        refreshTaskStatusBar();
        logger.error('恢复未完成媒体任务失败', err);
        message.error(err?.message || '恢复未完成媒体任务失败');
      });
  }, [pendingMediaPrompt, pendingMediaAction, message, refreshTaskStatusBar]);

  const handleFailPendingMediaTasks = useCallback(async () => {
    if (!pendingMediaPrompt || pendingMediaAction) return;

    setPendingMediaAction('fail');
    try {
      const failedCount = await failPendingMediaTasks(
        pendingMediaPrompt.projectId,
        pendingMediaPrompt.tasks,
        USER_INTERRUPTED_REASON
      );
      setPendingMediaPrompt(null);
      refreshTaskStatusBar();
      message.warning(`已将 ${failedCount} 个未完成媒体任务标记为失败`);
    } catch (err: any) {
      logger.error('标记未完成媒体任务失败', err);
      message.error(err?.message || '标记任务失败失败');
    } finally {
      setPendingMediaAction(null);
    }
  }, [pendingMediaPrompt, pendingMediaAction, message, refreshTaskStatusBar]);

  const handleDeletePendingMediaTasks = useCallback(async () => {
    if (!pendingMediaPrompt || pendingMediaAction) return;

    setPendingMediaAction('delete');
    try {
      const deletedCount = await deletePendingMediaTasks(pendingMediaPrompt.projectId, pendingMediaPrompt.tasks);
      setPendingMediaPrompt(null);
      refreshTaskStatusBar();
      message.success(`已删除 ${deletedCount} 条本地任务记录；这不会取消远端生成`);
    } catch (err: any) {
      logger.error('删除未完成媒体任务记录失败', err);
      message.error(err?.message || '删除本地任务记录失败');
    } finally {
      setPendingMediaAction(null);
    }
  }, [pendingMediaPrompt, pendingMediaAction, message, refreshTaskStatusBar]);

  const pendingMediaTaskSummary = pendingMediaPrompt
    ? summarizePendingMediaTasks(pendingMediaPrompt.tasks)
    : '';

  return (
    <div className="flex flex-col h-screen bg-bg-app text-text-primary font-sans selection:bg-accent/30">
      <WindowControls />
      <div className="flex flex-1 min-h-0">
        <Sidebar
          view={view}
          activeProject={activeProject}
          activeEpisode={activeEpisode}
          onViewChange={setView}
          onConfigChange={reloadSettings}
        />
        <div className="flex-1 flex flex-col min-w-0 transition-all duration-300">
          <main className="flex-1 overflow-hidden relative bg-bg-app">
            {view === 'projects' && (
              projectsLoading ? (
                <div className="flex h-full items-center justify-center">
                  <Spin size="large" description="加载项目列表..."><div className="p-12" /></Spin>
                </div>
              ) : (
                <ProjectList
                  projects={displayProjects}
                  onSelectProject={handleSelectProject}
                  onCreateProject={() => setIsCreateModalOpen(true)}
                  onDeleteProject={handleDeleteProject}
                />
              )
            )}
            {view === 'settings' && (
              <Suspense fallback={<ViewLoading tip="加载设置页面..." />}>
                <SettingsPage settings={appSettings} onSave={setAppSettings} />
              </Suspense>
            )}
            {view === 'plugins' && (
              <Suspense fallback={<ViewLoading tip="加载插件管理..." />}>
                <PluginManager />
              </Suspense>
            )}
            {view === 'chat' && (
              <Suspense fallback={<ViewLoading tip="加载对话页面..." />}>
                <ChatPage />
              </Suspense>
            )}
            {view.startsWith('plugin:') && (
              <Suspense fallback={<ViewLoading tip="加载插件..." />}>
                <PluginHost pluginId={view.replace('plugin:', '')} />
              </Suspense>
            )}
            {view === 'editor' && activeProject && (
              <Suspense fallback={<ViewLoading tip="加载中..." />}>
                <EditorView
                  activeProject={activeProject}
                  activeEpisode={activeEpisode}
                  editorStep={editorStep}
                  stepProgress={stepProgress}
                  scriptText={scriptText}
                  analysisData={analysisData}
                  appSettings={appSettings}
                  mentionItems={mentionItems}
                  onStepChange={setEditorStep}
                  onStepChangeWithMark={handleStepChangeWithMark}
                  onViewChange={setView}
                  onOpenProjectSettings={() => setIsProjectSettingsOpen(true)}
                  onScriptChange={setScriptText}
                  onProjectUpdate={(updates) => setActiveProject(prev => prev ? { ...prev, ...updates } : prev)}
                  onActiveEpisodeChange={setActiveEpisode}
                />
              </Suspense>
            )}
          </main>
        </div>
      </div>
      <CreateProjectModal isOpen={isCreateModalOpen} onClose={() => setIsCreateModalOpen(false)} onCreate={handleCreateProject} />
      <ProjectSettingsModal
        project={activeProject}
        open={isProjectSettingsOpen}
        onClose={() => setIsProjectSettingsOpen(false)}
        onSave={handleProjectSettingsSave}
        onGoToGlobalSettings={() => { setIsProjectSettingsOpen(false); setView('settings'); }}
        itvDurationSpec={projectItvDurationSpec}
      />
      {pendingMediaPrompt && (
        <div
          role="status"
          aria-live="polite"
          className="fixed bottom-28 right-4 z-40 w-[22rem] max-w-[calc(100vw-2rem)] rounded-2xl border border-status-warning/30 bg-bg-surface/95 p-4 text-sm shadow-2xl backdrop-blur"
        >
          <div className="flex items-start gap-3">
            <div className="mt-1 h-2 w-2 shrink-0 rounded-full bg-status-warning shadow-[0_0_12px_color-mix(in_srgb,var(--token-status-warning)_55%,transparent)]" />
            <div className="min-w-0 flex-1">
              <div className="font-medium text-text-primary">发现未完成任务</div>
              <div className="mt-1.5 leading-5 text-text-secondary">
                上次还有 {pendingMediaPrompt.tasks.length} 个媒体任务未完成。
              </div>
              {pendingMediaTaskSummary && (
                <div className="mt-1 text-xs leading-5 text-text-tertiary">
                  {pendingMediaTaskSummary}
                </div>
              )}
              <div className="mt-2 text-xs leading-5 text-status-warning/80">
                删除本地记录不会取消远端生成。
              </div>
              <div className="mt-3 flex flex-wrap justify-end gap-2">
                <Button
                  size="small"
                  danger
                  loading={pendingMediaAction === 'delete'}
                  disabled={Boolean(pendingMediaAction) && pendingMediaAction !== 'delete'}
                  onClick={handleDeletePendingMediaTasks}
                >
                  删除本地记录
                </Button>
                <Button
                  size="small"
                  loading={pendingMediaAction === 'fail'}
                  disabled={Boolean(pendingMediaAction) && pendingMediaAction !== 'fail'}
                  onClick={handleFailPendingMediaTasks}
                >
                  标记失败
                </Button>
                <Button
                  size="small"
                  type="primary"
                  disabled={Boolean(pendingMediaAction) && pendingMediaAction !== 'recover'}
                  onClick={handleRecoverPendingMediaTasks}
                >
                  继续恢复
                </Button>
              </div>
            </div>
          </div>
        </div>
      )}
      {/* 全局任务状态悬浮通知 */}
      {activeProject && (
        <TaskStatusBar key={`${activeProject.id}:${taskStatusRefreshKey}`} projectId={activeProject.id} />
      )}
    </div>
  );
};

const App: React.FC = () => {
  return (
    <ErrorBoundary>
      <AntApp>
        <AppContent />
      </AntApp>
    </ErrorBoundary>
  );
};

export default App;
