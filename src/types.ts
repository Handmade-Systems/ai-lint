// --- Config Types ---

export type Provider = 'openrouter' | 'ollama' | 'claude-code'
export type OpenRouterModel = 'gemini-flash' | 'haiku' | 'sonnet' | 'opus'
export type Model = OpenRouterModel | (string & {})
export type Severity = 'error' | 'warning'

export interface LinterConfig {
  provider: Provider
  provider_url?: string
  model: Model
  concurrency: number
  git_base: string
  rules: LintRule[]
}

export interface LintRule {
  id: string // unique, snake_case
  name: string // display name
  severity: Severity
  glob: string // file matching pattern
  exclude?: string // exclude pattern
  prompt: string // AI prompt for this rule
  model?: Model // override default model
  enabled?: boolean // default: true
}

// --- Client Interface ---

export interface LintClient {
  lint(job: LintJob): Promise<LintResult>
}

// --- Execution Types ---

export interface LintJob {
  rule: LintRule
  filePath: string
  fileContent: string
  fileHash: string // SHA-256 of file content
  promptHash: string // SHA-256 of rule prompt
}

export interface LintResult {
  rule_id: string
  rule_name: string
  file: string
  severity: Severity
  pass: boolean
  message: string // AI explanation
  line?: number // optional line reference
  duration_ms: number
  cached: boolean // true if from cache
  api_error?: boolean // true if result is due to API failure, not actual lint
}

// --- Cache Types ---

export interface CacheEntry {
  file_hash: string
  prompt_hash: string
  rule_id: string
  result: LintResult
  timestamp: string // ISO 8601
}

// Cache-Datei: .ai-lint/cache.json
export interface CacheStore {
  version: 1
  entries: Record<string, CacheEntry> // key: `${rule_id}:${filePath}`
}

// --- Reporter Types ---

export interface LintSummary {
  total_files: number
  total_rules_applied: number
  passed: number
  errors: number
  warnings: number
  cached: number
  duration_ms: number
}
