/**
 * OpenAI 兼容 /v1/audio/speech 协议的 TTS Provider（默认模型 qwen-tts）。
 * baseUrl 由用户在渠道配置中填写，可指向任何兼容上游或自建网关。
 *
 * 接入示意：
 *   curl -X POST <baseUrl>/v1/audio/speech \
 *     -H "Authorization: Bearer <API Key>" \
 *     -H "Content-Type: application/json" \
 *     -d '{"model":"qwen-tts","voice":"cherry","input":"测试"}' \
 *     --output out.wav
 *
 * 设计动机：与现有 OpenAITTSProvider 体系对齐，但内置默认音色清单（先放 cherry / 芊悦
 * 一个，后续再扩），避免 UI 上让用户面对一个空 voice 输入框。
 */
import type { TTSConfig, AudioResult, Voice } from '../../types';
import type { ProviderStartResult } from '../../types';
import type { TTSProvider, TTSRequest } from './types';
import { electronService } from '../../services/electronService';
import { createLogger } from '../../store/logger';
import { fetchWithChannelAuth } from '../channel/auth';
import { isChannelNetError } from '../netError';
import { KOMA_TTS_VOICES, KOMA_TTS_DEFAULT_VOICE_ID } from './komaTTSVoices';

export { KOMA_TTS_VOICES } from './komaTTSVoices';

const logger = createLogger('KomaTTSProvider');

const DEFAULT_MODEL = 'qwen-tts';
const DEFAULT_VOICE_ID = KOMA_TTS_DEFAULT_VOICE_ID;

export class KomaTTSProvider implements TTSProvider {
  type: 'koma-tts' = 'koma-tts';
  config: TTSConfig;

  constructor(config: TTSConfig) {
    this.config = config;
  }

  private getBaseUrl(): string {
    const url = String(this.config.baseUrl || '').trim();
    if (!url) {
      throw new Error('KomaTTSProvider 缺少 baseUrl，请在渠道配置中填写');
    }
    return url.replace(/\/+$/, '');
  }

  private getModelName(): string {
    const value = String(this.config.modelName || '').trim();
    return value || DEFAULT_MODEL;
  }

  validate(): boolean {
    return Boolean(this.config.profileId || this.config.apiKey);
  }

  async testConnection(): Promise<boolean> {
    return this.validate();
  }

  async start(request: TTSRequest): Promise<ProviderStartResult<AudioResult>> {
    const { text, voiceId, options } = request;
    if (!this.config.profileId && !this.config.apiKey) {
      throw new Error('Koma 激活 Key 未配置');
    }
    const trimmedText = String(text || '').trim();
    if (!trimmedText) {
      throw new Error('TTS 输入文本为空');
    }

    const voice = String(voiceId || this.config.defaultVoice || DEFAULT_VOICE_ID).trim();
    if (!voice) {
      throw new Error('TTS 音色未指定');
    }

    let response: Response;
    try {
      response = await fetchWithChannelAuth(
        `${this.getBaseUrl()}/v1/audio/speech`,
        {
          channelId: this.config.profileId,
          apiKey: this.config.apiKey,
          mode: 'bearer-header',
          fetchOptions: {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              model: this.getModelName(),
              input: trimmedText,
              voice,
              // OpenAI 兼容字段：speed (0.25-4.0)，缺省 1.0；options.rate 来自 TTSOptions
              speed: options?.rate || 1.0,
            }),
          },
        },
      );
    } catch (err) {
      if (isChannelNetError(err)) {
        throw new Error(`Koma TTS 合成失败 (${err.status}): ${err.message}`);
      }
      throw err;
    }

    const blob = await response.blob();

    // Electron：落盘到 cache/tts，与其它 TTS Provider 行为一致
    if (electronService.isElectron()) {
      try {
        const storagePath = await electronService.getStoragePath?.();
        if (storagePath) {
          const ttsDir = `${storagePath}/cache/tts`;
          await electronService.fs.mkdir(ttsDir);
          const filename = `koma_${Date.now()}_${Math.random().toString(36).slice(2, 8)}.wav`;
          const filePath = `${ttsDir}/${filename}`;
          const arrayBuffer = await blob.arrayBuffer();
          const uint8Array = new Uint8Array(arrayBuffer);
          await electronService.fs.writeFileBuffer(filePath, uint8Array);
          return {
            mode: 'immediate',
            output: {
              path: filePath,
              duration: 0,
              sampleRate: 24000,
              format: 'wav',
            },
          };
        }
      } catch (err) {
        logger.warn('落盘 Koma TTS 输出失败，降级返回 Blob URL', err);
      }
    }

    // 浏览器兜底：Blob URL（生命周期与渲染上下文绑定）
    const url = URL.createObjectURL(blob);
    return {
      mode: 'immediate',
      output: {
        path: url,
        duration: 0,
        sampleRate: 24000,
        format: 'wav',
      },
    };
  }

  async listVoices(): Promise<Voice[]> {
    return KOMA_TTS_VOICES;
  }
}

export default KomaTTSProvider;
