/**
 * 前端 FFmpeg 管理器
 * 负责与 Electron FFmpeg 服务通信，管理帧缓存和波形缓存
 */
import { isElectron } from './electronService';
import { createLogger } from '../store/logger';

const logger = createLogger('FFmpegManager');

// 媒体信息类型
export interface MediaInfo {
  duration: number;       // 毫秒
  width?: number;
  height?: number;
  fps?: number;
  format: string;
  videoCodec?: string;
  audioCodec?: string;
  bitrate?: number;
  audioChannels?: number;
  audioSampleRate?: number;
  hasVideo: boolean;
  hasAudio: boolean;
}

// 抽帧选项
export interface ExtractFramesOptions {
  input: string;
  outputDir: string;
  fps?: number;
  startTime?: number;
  endTime?: number;
  width?: number;
  quality?: number;
}

// 宫格图片分割选项（支持 2×2 / 3×3 / 4×4 / 5×5）
export interface SplitGridImageOptions {
  input: string;
  outputDir: string;
  aspectRatio?: string;
  gridSize?: 2 | 3 | 4 | 5;
  minCellWidth?: number;
  minCellHeight?: number;
  targetWidth?: number;
  targetHeight?: number;
  sharpenAmount?: number;
  format?: 'png' | 'jpg' | 'webp';
}

// 波形生成选项
export interface WaveformOptions {
  input: string;
  output: string;
  width?: number;
  height?: number;
  color?: string;
  backgroundColor?: string;
}

// 资源处理结果
export interface ResourceProcessResult {
  mediaInfo: MediaInfo;
  frames?: string[];       // 帧文件路径列表
  waveform?: string;       // 波形图路径
  audioPath?: string;      // 分离后的音频路径
}

// 视频合成选项
export interface ComposeVideoOptions {
  /** 帧序列所在目录（绝对路径） */
  frameDir: string;
  /** 帧文件名占位（不含目录），例如 'frame_%05d.png' */
  framePattern: string;
  fps: number;
  width: number;
  height: number;
  format: 'mp4' | 'webm' | 'gif';
  videoBitrate: number;    // kbps
  audioBitrate: number;    // kbps
  audioTracks: Array<{
    src: string;
    start: number;
    duration: number;
    offset: number;
    volume: number;
    fadeInDuration?: number;
    fadeOutDuration?: number;
  }>;
  outputPath: string;
  onProgress?: (percent: number) => void;
}

// 获取 FFmpeg API
const getFFmpegAPI = (): any => {
  if (isElectron() && window.electronAPI?.ffmpeg) {
    return window.electronAPI.ffmpeg;
  }
  return null;
};

/**
 * FFmpeg 管理器
 */
class FFmpegManager {
  private frameCache: Map<string, string[]> = new Map();
  private posterFrameCache: Map<string, string> = new Map();
  private lastFrameCache: Map<string, string> = new Map();
  private waveformCache: Map<string, string> = new Map();
  private mediaInfoCache: Map<string, MediaInfo> = new Map();
  private cacheDir: string = '';
  private initialized: boolean = false;

  /**
   * 初始化管理器
   */
  async init(): Promise<void> {
    if (this.initialized) return;

    const api = getFFmpegAPI();
    if (api) {
      try {
        this.cacheDir = await api.getCacheDir();
      } catch (err) {
        logger.warn('Failed to get cache dir:', err);
      }
    }

    this.initialized = true;
  }

  /**
   * 检查 FFmpeg 是否可用
   */
  async isAvailable(): Promise<boolean> {
    const api = getFFmpegAPI();
    if (!api) return false;

    try {
      return await api.isAvailable();
    } catch {
      return false;
    }
  }

  /**
   * 获取媒体信息
   */
  async getMediaInfo(filePath: string): Promise<MediaInfo> {
    // 检查缓存
    if (this.mediaInfoCache.has(filePath)) {
      return this.mediaInfoCache.get(filePath)!;
    }

    const api = getFFmpegAPI();
    if (!api) {
      throw new Error('FFmpeg 不可用');
    }

    const info = await api.getInfo(filePath);
    this.mediaInfoCache.set(filePath, info);
    return info;
  }

  /**
   * 抽取视频帧
   */
  async extractFrames(options: ExtractFramesOptions): Promise<string[]> {
    const cacheKey = this.getFrameCacheKey(options);

    // 检查缓存
    if (this.frameCache.has(cacheKey)) {
      return this.frameCache.get(cacheKey)!;
    }

    const api = getFFmpegAPI();
    if (!api) {
      throw new Error('FFmpeg 不可用');
    }

    const frames = await api.extractFrames(options);
    this.frameCache.set(cacheKey, frames);
    return frames;
  }

  /**
   * 宫格图片分割（支持 2×2 / 3×3 / 4×4 / 5×5）
   */
  async splitGridImage(options: SplitGridImageOptions): Promise<string[]> {
    await this.init();
    const api = getFFmpegAPI();
    if (!api) {
      throw new Error('FFmpeg 不可用');
    }

    const available = await this.isAvailable();
    if (!available) {
      throw new Error('FFmpeg 不可用');
    }

    return await api.splitGridImage(options);
  }

  /**
   * 提取视频首帧，作为缩略图/预览图。
   */
  async getPosterFrame(
    filePath: string,
    resourceId: string,
    width: number = 320
  ): Promise<string | null> {
    const cacheKey = `${filePath}:${resourceId}:${width}:poster`;
    if (this.posterFrameCache.has(cacheKey)) {
      return this.posterFrameCache.get(cacheKey)!;
    }

    await this.init();
    const api = getFFmpegAPI();
    if (!api) {
      return null;
    }

    const available = await this.isAvailable();
    if (!available) {
      return null;
    }

    const rootDir = await api.getCacheDir('video-posters');
    const outputDir = `${rootDir}/${resourceId}`;
    await api.ensureDir(outputDir);

    const frames = await api.extractFrames({
      input: filePath,
      outputDir,
      fps: 1,
      startTime: 0,
      endTime: 0.1,
      width,
      quality: 2,
    });

    const firstFrame = Array.isArray(frames) && frames.length > 0 ? frames[0] : null;
    if (firstFrame) {
      this.posterFrameCache.set(cacheKey, firstFrame);
    }
    return firstFrame;
  }

  /**
   * 提取视频尾帧（末帧），用于分镜续接续镜的连续性锚点。
   * 与 getPosterFrame 对称：先取媒体时长，再在结尾前 0.15s 处抽帧，
   * 避免正好落在最后一帧之外导致抽帧失败。
   */
  async getLastFrame(
    filePath: string,
    resourceId: string,
    width: number = 320
  ): Promise<string | null> {
    const cacheKey = `${filePath}:${resourceId}:${width}:lastframe`;
    if (this.lastFrameCache.has(cacheKey)) {
      return this.lastFrameCache.get(cacheKey)!;
    }

    await this.init();
    const api = getFFmpegAPI();
    if (!api) {
      return null;
    }

    const available = await this.isAvailable();
    if (!available) {
      return null;
    }

    try {
      const mediaInfo = await this.getMediaInfo(filePath);
      const durationSec = (mediaInfo.duration || 0) / 1000;
      if (!durationSec) return null;

      const rootDir = await api.getCacheDir('video-last-frames');
      const outputDir = `${rootDir}/${resourceId}`;
      await api.ensureDir(outputDir);

      const startTime = Math.max(0, durationSec - 0.15);
      const frames = await api.extractFrames({
        input: filePath,
        outputDir,
        fps: 1,
        startTime,
        endTime: durationSec,
        width,
        quality: 2,
      });

      const lastFrame = Array.isArray(frames) && frames.length > 0 ? frames[frames.length - 1] : null;
      if (lastFrame) {
        this.lastFrameCache.set(cacheKey, lastFrame);
      }
      return lastFrame;
    } catch (err) {
      logger.warn('提取视频尾帧失败:', err);
      return null;
    }
  }

  /**
   * 生成音频波形
   */
  async generateWaveform(options: WaveformOptions): Promise<string> {
    // 检查缓存
    if (this.waveformCache.has(options.input)) {
      return this.waveformCache.get(options.input)!;
    }

    const api = getFFmpegAPI();
    if (!api) {
      throw new Error('FFmpeg 不可用');
    }

    const waveformPath = await api.waveform(options);
    this.waveformCache.set(options.input, waveformPath);
    return waveformPath;
  }

  /**
   * 分离音频
   */
  async splitAudio(input: string, output: string): Promise<string> {
    const api = getFFmpegAPI();
    if (!api) {
      throw new Error('FFmpeg 不可用');
    }

    return await api.splitAudio(input, output);
  }

  /**
   * 处理资源（获取媒体信息、抽帧、生成波形）
   */
  async processResource(
    filePath: string,
    resourceId: string,
    options?: {
      extractFrames?: boolean;
      generateWaveform?: boolean;
      splitAudio?: boolean;
      framesFps?: number;
      framesWidth?: number;
    }
  ): Promise<ResourceProcessResult> {
    await this.init();

    // 获取媒体信息
    const mediaInfo = await this.getMediaInfo(filePath);

    const result: ResourceProcessResult = { mediaInfo };

    // 构建缓存目录
    const resourceCacheDir = `${this.cacheDir}/${resourceId}`;

    // 抽帧
    if (options?.extractFrames && mediaInfo.hasVideo) {
      result.frames = await this.extractFrames({
        input: filePath,
        outputDir: `${resourceCacheDir}/frames`,
        fps: options.framesFps ?? 1,
        width: options.framesWidth ?? 320
      });
    }

    // 生成波形
    if (options?.generateWaveform && mediaInfo.hasAudio) {
      result.waveform = await this.generateWaveform({
        input: filePath,
        output: `${resourceCacheDir}/waveform.png`
      });
    }

    // 分离音频
    if (options?.splitAudio && mediaInfo.hasAudio && mediaInfo.hasVideo) {
      const ext = mediaInfo.audioCodec === 'aac' ? 'm4a' : 'mp3';
      result.audioPath = await this.splitAudio(
        filePath,
        `${resourceCacheDir}/audio.${ext}`
      );
    }

    return result;
  }

  /**
   * 获取资源的帧
   */
  async getFrames(
    filePath: string,
    resourceId: string,
    timeRange?: [number, number]
  ): Promise<string[]> {
    const cacheKey = `${resourceId}:${timeRange?.join('-') || 'all'}`;

    if (this.frameCache.has(cacheKey)) {
      const cached = this.frameCache.get(cacheKey)!;
      logger.info('[getFrames] memory cache hit', { resourceId, count: cached.length });
      return cached;
    }

    if (!this.cacheDir) {
      logger.warn('[getFrames] cacheDir 为空，init 是否成功？', { resourceId, filePath });
    }

    const resourceCacheDir = `${this.cacheDir}/${resourceId}/frames`;
    logger.info('[getFrames] extracting', {
      resourceId,
      filePath,
      outputDir: resourceCacheDir,
      timeRange,
    });

    const frames = await this.extractFrames({
      input: filePath,
      outputDir: resourceCacheDir,
      fps: 1,
      startTime: timeRange?.[0],
      endTime: timeRange?.[1]
    });

    logger.info('[getFrames] extracted', {
      resourceId,
      count: Array.isArray(frames) ? frames.length : 0,
      first: Array.isArray(frames) ? frames[0] : undefined,
    });

    return frames;
  }

  /**
   * 获取资源的波形图
   */
  async getWaveform(filePath: string, resourceId: string): Promise<string> {
    if (this.waveformCache.has(filePath)) {
      return this.waveformCache.get(filePath)!;
    }

    const output = `${this.cacheDir}/${resourceId}/waveform.png`;
    return this.generateWaveform({ input: filePath, output });
  }

  /**
   * 生成帧缓存键
   */
  private getFrameCacheKey(options: ExtractFramesOptions): string {
    return `${options.input}:${options.fps || 1}:${options.startTime || 0}:${options.endTime || 'end'}:${options.width || 'auto'}`;
  }

  /**
   * 清除资源缓存
   */
  clearResourceCache(resourceId: string): void {
    // 清除帧缓存
    for (const key of this.frameCache.keys()) {
      if (key.startsWith(resourceId)) {
        this.frameCache.delete(key);
      }
    }
  }

  /**
   * 清除所有缓存
   */
  async clearAllCache(): Promise<void> {
    this.frameCache.clear();
    this.waveformCache.clear();
    this.mediaInfoCache.clear();

    const api = getFFmpegAPI();
    if (api) {
      await api.clearCache();
    }
  }

  /**
   * 取消当前任务
   */
  async cancelCurrentTask(): Promise<void> {
    const api = getFFmpegAPI();
    if (api) {
      await api.cancelTask();
    }
  }

  /**
   * 清空任务队列
   */
  async clearQueue(): Promise<void> {
    const api = getFFmpegAPI();
    if (api) {
      await api.clearQueue();
    }
  }

  /**
   * 合成视频（图片序列 + 音频 -> 视频文件）。
   *
   * IPC 不支持 structuredClone Function，必须剥离 onProgress 后再传过桥。
   * 进度回调暂时丢弃；端到端进度由调用方在帧渲染阶段自行追踪即可。
   */
  async composeVideo(options: ComposeVideoOptions): Promise<string> {
    const api = getFFmpegAPI();
    if (!api) {
      throw new Error('FFmpeg 不可用');
    }

    const { onProgress: _onProgress, ...rest } = options;
    void _onProgress;
    return await api.composeVideo(rest);
  }

  /**
   * 获取临时目录
   */
  async getTempDir(): Promise<string> {
    const api = getFFmpegAPI();
    if (api) {
      return await api.getTempDir();
    }
    return '/tmp/koma-export';
  }

  /**
   * 确保目录存在
   */
  async ensureDir(dirPath: string): Promise<void> {
    const api = getFFmpegAPI();
    if (api) {
      await api.ensureDir(dirPath);
    }
  }

  /**
   * 保存帧图片
   */
  async saveFrame(filePath: string, dataUrl: string): Promise<void> {
    const api = getFFmpegAPI();
    if (api) {
      await api.saveFrame(filePath, dataUrl);
    }
  }

  /**
   * 清理临时目录
   */
  async cleanupTemp(tempDir: string): Promise<void> {
    const api = getFFmpegAPI();
    if (api) {
      await api.cleanupTemp(tempDir);
    }
  }
}

// 单例
export const ffmpegManager = new FFmpegManager();
export default ffmpegManager;
