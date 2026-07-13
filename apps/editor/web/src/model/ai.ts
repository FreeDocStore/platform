import type { AiProvider, AiProviderSpec } from './types'

export const AI_PROVIDERS: Record<AiProvider, AiProviderSpec> = {
  github: {
    label: 'GitHub Models (free)',
    endpoint: 'https://models.github.ai/inference/chat/completions',
    defaultModel: 'openai/gpt-4o-mini',
    free: true,
  },
  openai: {
    label: 'OpenAI',
    endpoint: 'https://api.openai.com/v1/chat/completions',
    defaultModel: 'gpt-4.1-mini',
    keyPrefix: 'sk-',
    keysUrl: 'https://platform.openai.com/api-keys',
  },
  anthropic: {
    label: 'Anthropic',
    endpoint: 'https://api.anthropic.com/v1/messages',
    defaultModel: 'claude-sonnet-4-6',
    keyPrefix: 'sk-ant-',
    keysUrl: 'https://console.anthropic.com/settings/keys',
  },
}

export const AI_PROVIDER_IDS = Object.keys(AI_PROVIDERS) as AiProvider[]

/** Providers that require a user-supplied API key (excludes the free GitHub tier). */
export const BYOK_PROVIDER_IDS = AI_PROVIDER_IDS.filter((id) => !AI_PROVIDERS[id].free) as Exclude<AiProvider, 'github'>[]
