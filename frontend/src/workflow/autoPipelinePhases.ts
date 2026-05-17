/**
 * Auto Pipeline Phases — 把现有 service / handler 包成 PhaseDefinition 数组
 *
 * 设计要点：
 * 1. 每个 phase.run 是 () => Promise<void>，等到底层任务完成才 resolve；
 *    抛错让 runner 走 awaiting 状态。
 *
 * 2. 主进程异步任务（submitShotAnalysisTask 那种）：runner 这层用
 *    waitForTaskTransition 桥接，等任务变 completed/failed 再 resolve。
 *
 * 3. 现有 Storyboard.tsx 里的 handle* handler 内部都是 message.error()，
 *    runner 不依赖 message —— 失败让底层 service throw，由 runner 抓到。
 *    所以本文件**不复用 handle**，直接绕开 UI 层调底层 service。
 */

import type { AppSettings, Character, Scene, Prop } from '../types';
import { batchGenerateShotImages } from '../services/ShotGenerationService';
import { batchRenderShots } from './shotRenderWorkflow';
import { batchGenerateShotPrompts } from '../services/ShotPromptService';
import {
  generateTweetScript,
  distributeTweetToShots,
} from '../services/TweetCopyService';
import { polishScript } from './scriptGenerator';
import { createCreationContext } from '../services/CreationContext';
import { submitShotAnalysisTask, submitScriptAnalysisTask } from '../services/analysisTaskClient';
import { saveEpisode, loadEpisodeShots, loadCharacters, loadScenes, loadProps } from '../store/projectStore';
import { subscribeTaskTransitions } from '../store/tasksStore';
import { generateCostumePhoto } from './characterAssetWorkflow';
import { generateSceneImage, generatePropImage } from './scenePropAssetWorkflow';
import { runWithConcurrency } from '../utils/concurrency';
import type { PhaseDefinition } from './autoPipelineRunner';
import type { TaskRecord } from '../services/tasksIPC';

/**
 * 流水线运行所需的全部上下文。从 Storyboard / EditorView 透传。
 */
export interface AutoPipelineContext {
  projectId: string;
  episodeId: string;
  episodeName?: string;
  /** 当前剧本文本快照；polishScript / generateTweetScript 会读 + 改 */
  scriptText: string;
  /** 当 polish/tweet/distribute 改了文本/分镜，要把结果写回 UI 状态 */
  onScriptChange: (next: string) => void;
  /** 标记 episode.scriptReady = true（推文化后必须置位才能进解析与下一步） */
  onMarkScriptReady: () => Promise<void>;
  appSettings: AppSettings;
  llmSelection?: string;
  ttiSelection?: string;
  itvSelection?: string;
  ttsSelection?: string;
  styleSnapshot?: Record<string, unknown>;
  projectStylePrompt?: string;
  aspectRatio?: string;
  /** 跑完所有阶段后切换到剪辑步骤 */
  onJumpToVideoStep: () => void;
}

/**
 * 等待主进程任务到达指定终态；taskId 是 submitTask 返回的 record.id。
 */
function waitForTaskTransition(
  taskId: string,
  targetStatuses: ReadonlyArray<string> = ['completed', 'failed'],
): Promise<TaskRecord> {
  return new Promise((resolve, reject) => {
    const unsubscribe = subscribeTaskTransitions((event) => {
      if (event.record.id !== taskId) return;
      if (!targetStatuses.includes(event.currStatus)) return;
      unsubscribe();
      if (event.currStatus === 'completed') {
        resolve(event.record);
      } else {
        const err = (event.record.payload as Record<string, unknown> | undefined)?.error
          || event.record.error
          || `任务 ${taskId} 进入 ${event.currStatus} 状态`;
        reject(new Error(typeof err === 'string' ? err : JSON.stringify(err)));
      }
    });
  });
}

/** 工厂：根据上下文构造 12 个 PhaseDefinition。 */
export function buildPipelinePhases(ctx: AutoPipelineContext): PhaseDefinition[] {
  return [
    // ============= 剧本预处理 =============
    {
      id: 'polish',
      group: 'script',
      label: 'AI 润色剧本',
      defaultEnabled: false,
      run: async () => {
        if (!ctx.scriptText?.trim()) throw new Error('剧本为空，无法润色');
        const polished = await polishScript(
          ctx.appSettings,
          ctx.scriptText,
          undefined,
          () => undefined,
          (ctx.styleSnapshot as any) || undefined,
        );
        if (polished?.trim()) ctx.onScriptChange(polished);
      },
    },
    {
      id: 'tweet',
      group: 'script',
      label: '推文化（改写为字幕格式）',
      defaultEnabled: true,
      run: async () => {
        if (!ctx.scriptText?.trim()) throw new Error('剧本为空，无法推文化');
        const creationCtx = await createCreationContext(ctx.projectId, ctx.episodeId, {
          llmConfigId: ctx.llmSelection,
          styleSnapshot: ctx.styleSnapshot as any,
        });
        const result = await generateTweetScript(creationCtx, ctx.scriptText);
        if (result?.trim()) ctx.onScriptChange(result);
        await ctx.onMarkScriptReady();
      },
    },

    // ============= 资产 =============
    {
      id: 'extractEntities',
      group: 'assets',
      label: '提取角色 / 场景 / 道具',
      defaultEnabled: true,
      dependsOn: [],
      run: async () => {
        const { task } = await submitScriptAnalysisTask({
          projectId: ctx.projectId,
          episodeId: ctx.episodeId,
          episodeName: ctx.episodeName || `剧集 ${ctx.episodeId}`,
          script: ctx.scriptText,
          llmSelection: ctx.llmSelection,
          styleSnapshot: ctx.styleSnapshot as any,
        });
        await waitForTaskTransition(task.id);
      },
    },
    {
      id: 'referenceImages',
      group: 'assets',
      label: '批量生成参考图（角色 / 场景 / 道具）',
      defaultEnabled: true,
      dependsOn: ['extractEntities'],
      run: async () => {
        const [characters, scenes, props] = await Promise.all([
          loadCharacters(ctx.projectId) as Promise<Character[]>,
          loadScenes(ctx.projectId) as Promise<Scene[]>,
          loadProps(ctx.projectId) as Promise<Prop[]>,
        ]);

        // 角色：还没有 costumePhoto 的才生成
        const characterTasks = characters
          .filter(c => !c.media?.costumePhoto)
          .map(c => async () => {
            await generateCostumePhoto({
              projectId: ctx.projectId,
              character: c,
              aspectRatio: ctx.aspectRatio,
              styleSnapshot: ctx.styleSnapshot as any,
              ttiSelection: ctx.ttiSelection,
              stylePrompt: ctx.projectStylePrompt,
            } as any).catch(err => {
              console.warn(`[autoPipeline] 角色 ${c.name} 参考图生成失败`, err);
            });
          });

        // 场景：未生成 previewImage 的才跑
        const sceneTasks = scenes
          .filter(s => !s.media?.previewImage)
          .map(s => async () => {
            await generateSceneImage({
              projectId: ctx.projectId,
              scene: s,
              aspectRatio: ctx.aspectRatio,
              styleSnapshot: ctx.styleSnapshot as any,
              ttiSelection: ctx.ttiSelection,
              stylePrompt: ctx.projectStylePrompt,
            } as any).catch(err => {
              console.warn(`[autoPipeline] 场景 ${s.name} 参考图生成失败`, err);
            });
          });

        // 道具：未生成 previewImage 的才跑
        const propTasks = props
          .filter(p => !p.media?.previewImage)
          .map(p => async () => {
            await generatePropImage({
              projectId: ctx.projectId,
              prop: p,
              aspectRatio: ctx.aspectRatio,
              styleSnapshot: ctx.styleSnapshot as any,
              ttiSelection: ctx.ttiSelection,
              stylePrompt: ctx.projectStylePrompt,
            } as any).catch(err => {
              console.warn(`[autoPipeline] 道具 ${p.name} 参考图生成失败`, err);
            });
          });

        const tasks = [...characterTasks, ...sceneTasks, ...propTasks];
        if (tasks.length === 0) return;
        await runWithConcurrency(tasks, 2);
      },
    },

    // ============= 分镜 =============
    {
      id: 'generateShots',
      group: 'storyboard',
      label: 'AI 生成分镜',
      defaultEnabled: true,
      dependsOn: ['extractEntities'],
      run: async () => {
        const existing = await loadEpisodeShots(ctx.projectId, ctx.episodeId);
        if (existing.length > 0) return;  // 已有分镜则跳过

        const { task } = await submitShotAnalysisTask({
          projectId: ctx.projectId,
          episodeId: ctx.episodeId,
          episodeName: ctx.episodeName || `剧集 ${ctx.episodeId}`,
          script: ctx.scriptText,
          llmSelection: ctx.llmSelection,
          styleSnapshot: ctx.styleSnapshot as any,
        });
        await waitForTaskTransition(task.id);
      },
    },
    {
      id: 'distributeTweet',
      group: 'storyboard',
      label: '推文分发到分镜',
      defaultEnabled: true,
      dependsOn: ['tweet', 'generateShots'],
      run: async () => {
        const shots = await loadEpisodeShots(ctx.projectId, ctx.episodeId);
        if (shots.length === 0) throw new Error('分镜数据为空');
        const creationCtx = await createCreationContext(ctx.projectId, ctx.episodeId, {
          llmConfigId: ctx.llmSelection,
          styleSnapshot: ctx.styleSnapshot as any,
        });
        // distributeTweetToShots 调用方自行决定是否回写库；当前 Shot 类型已用 scriptLines
        // 取代 tweetCopy，分发结果由项目内现有的"AI 解析"流程整合。这里仅触发服务调用，
        // 不直接 saveEpisodeShots 以避免与新数据模型冲突。
        await distributeTweetToShots(creationCtx, ctx.scriptText, shots);
      },
    },
    {
      id: 'imagePrompts',
      group: 'storyboard',
      label: '批量生成图像提示词',
      defaultEnabled: true,
      dependsOn: ['generateShots'],
      run: async () => {
        const shots = await loadEpisodeShots(ctx.projectId, ctx.episodeId);
        const targets = shots.filter(s => !s.imagePrompt?.trim());
        if (targets.length === 0) return;
        await batchGenerateShotPrompts(
          ctx.projectId,
          ctx.episodeId,
          targets,
          ctx.projectStylePrompt,
          () => undefined,
          ctx.llmSelection,
          ctx.styleSnapshot as any,
          { image: true, video: false },
          { shotsSnapshot: shots },
        );
      },
    },
    {
      id: 'images',
      group: 'storyboard',
      label: '批量出图',
      defaultEnabled: true,
      dependsOn: ['imagePrompts'],
      run: async () => {
        const [shots, characters, scenes] = await Promise.all([
          loadEpisodeShots(ctx.projectId, ctx.episodeId),
          loadCharacters(ctx.projectId) as Promise<Character[]>,
          loadScenes(ctx.projectId) as Promise<Scene[]>,
        ]);
        const targets = shots.filter(s => {
          const imgCount = (s.media?.images || []).length;
          return imgCount === 0 && (s.imagePrompt?.trim()?.length ?? 0) > 0;
        });
        if (targets.length === 0) return;
        const shotIds = targets.map(s => s.id);
        await batchGenerateShotImages(
          ctx.projectId,
          ctx.episodeId,
          shotIds,
          characters,
          scenes,
          ctx.ttiSelection,
          {
            aspectRatio: ctx.aspectRatio as any,
            styleSnapshot: ctx.styleSnapshot as any,
            shotsSnapshot: shots,
          },
        );
      },
    },
    {
      id: 'videoPrompts',
      group: 'storyboard',
      label: '批量生成视频提示词',
      defaultEnabled: true,
      dependsOn: ['images'],
      run: async () => {
        const shots = await loadEpisodeShots(ctx.projectId, ctx.episodeId);
        const targets = shots.filter(s => !s.videoPrompt?.trim());
        if (targets.length === 0) return;
        await batchGenerateShotPrompts(
          ctx.projectId,
          ctx.episodeId,
          targets,
          ctx.projectStylePrompt,
          () => undefined,
          ctx.llmSelection,
          ctx.styleSnapshot as any,
          { image: false, video: true },
          { shotsSnapshot: shots },
        );
      },
    },
    {
      id: 'videos',
      group: 'storyboard',
      label: '批量出视频',
      defaultEnabled: true,
      dependsOn: ['videoPrompts'],
      run: async () => {
        const shots = await loadEpisodeShots(ctx.projectId, ctx.episodeId);
        const targets = shots.filter(s => {
          const videoCount = (s.media?.videos || []).length;
          return videoCount === 0 && (s.videoPrompt?.trim()?.length ?? 0) > 0;
        });
        if (targets.length === 0) return;
        await batchRenderShots(
          {
            projectId: ctx.projectId,
            episodeId: ctx.episodeId,
            shots: targets,
            settings: ctx.appSettings,
            aspectRatio: ctx.aspectRatio as any,
            mediaSelections: {
              ttiSelection: ctx.ttiSelection,
              itvSelection: ctx.itvSelection,
              ttsSelection: ctx.ttsSelection,
            },
            styleSnapshot: ctx.styleSnapshot as any,
            allShots: shots,
          } as any,
          () => undefined,
        );
      },
    },

    // ============= 配音 =============
    {
      id: 'audio',
      group: 'audio',
      label: '批量配音',
      defaultEnabled: false,
      dependsOn: ['distributeTweet'],
      run: async () => {
        // 配音目前没有底层"批量生成 audio"独立 service —— 走 batchRenderShots 的子流，
        // 但更稳的做法是复用 Storyboard 的 handler；这里发出"占位错误"提醒用户
        // 走 Storyboard "出视频" 的下拉里"配音 → 生成空白项"。
        throw new Error('配音批量入口暂未对接到一键流水线，请在分镜板顶部"配音"下拉里手动触发。');
      },
    },

    // ============= 完成 =============
    {
      id: 'jumpToVideo',
      group: 'final',
      label: '进入剪辑步骤',
      defaultEnabled: true,
      run: async () => {
        ctx.onJumpToVideoStep();
      },
    },
  ];
}

// 重新导出方便调用方用
export { saveEpisode };
