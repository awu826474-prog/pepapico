/**
 * Provider 注册表
 * 管理多个 Provider 实例，按名称获取
 */

import type { ModelProvider, ImageProvider, ProviderConfig } from './types.ts'
import { OpenAICompatibleProvider } from './openai-compatible.ts'
import { NanoBananaProvider } from './nano-banana.ts'
import { CopilotProvider } from './copilot.ts'
import type { CopilotProviderConfig } from './copilot.ts'

// 预置 baseURL 映射
const KNOWN_PROVIDERS: Record<string, string> = {
  openai: 'https://api.openai.com/v1',
  openrouter: 'https://openrouter.ai/api/v1',
  deepseek: 'https://api.deepseek.com/v1',
  groq: 'https://api.groq.com/openai/v1',
  ollama: 'http://localhost:11434/v1',
  together: 'https://api.together.xyz/v1',
  mistral: 'https://api.mistral.ai/v1',
  grsai: 'https://grsai.dakka.com.cn',
  copilot: 'https://api.githubcopilot.com',
}

const chatRegistry = new Map<string, ModelProvider>()
const imageRegistry = new Map<string, ImageProvider>()

/**
 * 注册一个 provider
 * 如果 name 是已知 provider 且未提供 baseURL，自动填充
 */
export function registerProvider(
  name: string,
  config: ProviderConfig,
): ModelProvider {
  const baseURL = config.baseURL || KNOWN_PROVIDERS[name.toLowerCase()]
  if (!baseURL) {
    throw new Error(`Unknown provider "${name}" and no baseURL provided`)
  }

  const provider = new OpenAICompatibleProvider(name, { ...config, baseURL })
  chatRegistry.set(name, provider)
  return provider
}

/** 注册一个图像生成 provider */
export function registerImageProvider(
  name: string,
  config: ProviderConfig,
): ImageProvider {
  const baseURL = config.baseURL || KNOWN_PROVIDERS[name.toLowerCase()]
  if (!baseURL) {
    throw new Error(`Unknown provider "${name}" and no baseURL provided`)
  }

  const provider = new NanoBananaProvider(name, { ...config, baseURL })
  imageRegistry.set(name, provider)
  return provider
}

/** 获取已注册的 chat provider */
export function getProvider(name: string): ModelProvider {
  const p = chatRegistry.get(name)
  if (!p) throw new Error(`Provider "${name}" not registered`)
  return p
}

/** 获取已注册的 image provider */
export function getImageProvider(name: string): ImageProvider {
  const p = imageRegistry.get(name)
  if (!p) throw new Error(`ImageProvider "${name}" not registered`)
  return p
}

/** 列出所有已注册 provider 名称 */
export function listProviders(): { chat: string[]; image: string[] } {
  return {
    chat: [...chatRegistry.keys()],
    image: [...imageRegistry.keys()],
  }
}

/** 快捷方式：注册并返回 OpenRouter provider */
export function createOpenRouter(apiKey: string): ModelProvider {
  return registerProvider('openrouter', {
    apiKey,
    baseURL: KNOWN_PROVIDERS.openrouter,
    headers: {
      'HTTP-Referer': 'https://byte-cp.local',
      'X-Title': 'Byte_cp',
    },
  })
}

/** 快捷方式：注册并返回 grsai NanoBanana provider */
export function createNanoBanana(apiKey: string): ImageProvider {
  return registerImageProvider('grsai', {
    apiKey,
    baseURL: KNOWN_PROVIDERS.grsai,
  })
}

/** 快捷方式：注册并返回 GitHub Copilot provider */
export function createCopilot(token: string, options?: Partial<CopilotProviderConfig>): CopilotProvider {
  const provider = new CopilotProvider({ token, ...options })
  chatRegistry.set('copilot', provider)
  return provider
}
