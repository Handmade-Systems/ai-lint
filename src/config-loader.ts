import fs from 'node:fs'
import Ajv, { type ErrorObject } from 'ajv'
import addFormats from 'ajv-formats'
import YAML from 'yaml'
import schema from './schema.json' with { type: 'json' }
import type { LinterConfig, OpenRouterModel } from './types.js'

const OPENROUTER_MODELS: Set<string> = new Set<OpenRouterModel>([
  'gemini-flash',
  'haiku',
  'sonnet',
  'opus',
])

export class ConfigLoader {
  private static ajvInstance: Ajv | null = null

  /**
   * Get cached AJV instance (lazy singleton)
   */
  private getAjv(): Ajv {
    if (!ConfigLoader.ajvInstance) {
      ConfigLoader.ajvInstance = new Ajv({
        allErrors: true,
        verbose: true,
      })
      addFormats(ConfigLoader.ajvInstance)
    }
    return ConfigLoader.ajvInstance
  }

  /**
   * Load and validate .ai-lint.yml config
   */
  load(filePath: string): LinterConfig {
    // Read YAML file
    const fileContent = fs.readFileSync(filePath, 'utf-8')
    const rawConfig = YAML.parse(fileContent)

    // Validate with JSON Schema
    const ajv = this.getAjv()
    const validate = ajv.compile(schema)
    const valid = validate(rawConfig)

    if (!valid) {
      const errors = this.formatValidationErrors(validate.errors || [])
      throw new Error(`Config validation failed:\n${errors}`)
    }

    // Apply defaults
    const raw = rawConfig as Record<string, unknown>
    const provider = (raw.provider as string | undefined) ?? 'openrouter'

    // Require model when provider is ollama (no sensible default)
    if (provider === 'ollama' && !raw.model) {
      throw new Error('Config validation failed:\n  - /model: is required when provider is ollama')
    }

    // claude-code provider: model is optional (uses CLI default)
    // No API key or URL needed

    const defaultConcurrency = provider === 'ollama' || provider === 'claude-code' ? 1 : 5

    const config: LinterConfig = {
      provider: provider as LinterConfig['provider'],
      provider_url:
        (raw.provider_url as string | undefined) ??
        (provider === 'ollama' ? 'http://localhost:11434/v1' : undefined),
      model: (raw.model as LinterConfig['model']) ?? 'gemini-flash',
      concurrency: (raw.concurrency as number) ?? defaultConcurrency,
      git_base: (raw.git_base as string) ?? 'main',
      rules: (raw.rules as LinterConfig['rules']).filter((r) => r.enabled !== false),
    }

    // Validate unique rule IDs (custom validation not in schema)
    this.validateUniqueRuleIds(config.rules)

    // Validate model names for openrouter provider (skip for ollama and claude-code)
    if (provider === 'openrouter') {
      this.validateOpenRouterModels(config)
    }

    return config
  }

  /**
   * Validate that all rule IDs are unique
   */
  private validateUniqueRuleIds(rules: LinterConfig['rules']): void {
    const ids = new Set<string>()
    const duplicates: string[] = []

    for (const rule of rules) {
      if (ids.has(rule.id)) {
        duplicates.push(rule.id)
      }
      ids.add(rule.id)
    }

    if (duplicates.length > 0) {
      throw new Error(
        `Duplicate rule IDs found: ${duplicates.join(', ')}. Each rule must have a unique ID.`,
      )
    }
  }

  /**
   * Validate that model names are known OpenRouter shortnames
   */
  private validateOpenRouterModels(config: LinterConfig): void {
    if (!OPENROUTER_MODELS.has(config.model)) {
      throw new Error(
        `Unknown model '${config.model}' for openrouter provider. Allowed values: ${[...OPENROUTER_MODELS].join(', ')}`,
      )
    }

    for (const rule of config.rules) {
      if (rule.model && !OPENROUTER_MODELS.has(rule.model)) {
        throw new Error(
          `Unknown model '${rule.model}' in rule '${rule.id}' for openrouter provider. Allowed values: ${[...OPENROUTER_MODELS].join(', ')}`,
        )
      }
    }
  }

  /**
   * Format AJV validation errors into readable messages
   */
  private formatValidationErrors(errors: ErrorObject[]): string {
    // Filter out verbose oneOf errors for cleaner messages
    const filteredErrors = errors.filter(
      (err) => err.keyword !== 'oneOf' && err.keyword !== 'additionalProperties',
    )

    if (filteredErrors.length === 0 && errors.length > 0) {
      // If we filtered everything out, use original errors
      return errors
        .map((err) => {
          const path = err.instancePath || 'root'
          return `  - ${path}: ${err.message}`
        })
        .join('\n')
    }

    return filteredErrors
      .map((err) => {
        const path = err.instancePath || 'root'
        const field = err.params.missingProperty ? `${path}/${err.params.missingProperty}` : path

        // Custom messages for common validation failures
        if (err.keyword === 'required') {
          return `  - ${field}: is required`
        }
        if (err.keyword === 'pattern') {
          return `  - ${field}: ${err.message} (expected format: lowercase with underscores, e.g., 'my_rule_id')`
        }
        if (err.keyword === 'enum') {
          return `  - ${field}: ${err.message}, allowed values: ${err.params.allowedValues?.join(', ')}`
        }
        if (err.keyword === 'minItems') {
          return `  - ${field}: must have at least ${err.params.limit} items`
        }

        return `  - ${field}: ${err.message}`
      })
      .join('\n')
  }
}
