import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AIClient } from './ai-client.js'
import { CacheManager } from './cache-manager.js'
import { ClaudeCodeClient } from './claude-code-client.js'
import { ConfigLoader } from './config-loader.js'
import { LinterEngine } from './linter-engine.js'
import { runReportOnlyLint } from './report-only-runner.js'
import { Reporter } from './reporter.js'
import { RuleMatcher } from './rule-matcher.js'
import type { LinterConfig } from './types.js'

// Mock the AI SDK at module level
const mockGenerateText = vi.fn()
vi.mock('ai', () => ({
  generateText: (...args: unknown[]) => mockGenerateText(...args),
  Output: {
    object: vi.fn((opts: unknown) => opts),
  },
}))

vi.mock('@openrouter/ai-sdk-provider', () => ({
  createOpenRouter: vi.fn(() => vi.fn((modelId: string) => ({ modelId }))),
}))

vi.mock('@ai-sdk/openai-compatible', () => ({
  createOpenAICompatible: vi.fn(() => vi.fn((modelName: string) => ({ modelId: modelName }))),
}))

// Mock child_process for claude-code tests
const mockExecFile = vi.fn()
vi.mock('node:child_process', () => ({
  execFile: (...args: unknown[]) => mockExecFile(...args),
}))

describe('E2E Tests — Full Workflow', () => {
  let tempDir: string

  beforeEach(() => {
    // Create temp directory for each test
    tempDir = mkdtempSync(join(tmpdir(), 'ai-lint-e2e-'))

    // Clear mock calls
    mockGenerateText.mockClear()

    // Set API key for tests
    process.env.OPEN_ROUTER_KEY = 'test-key'
  })

  afterEach(() => {
    // Clean up temp directory
    rmSync(tempDir, { recursive: true, force: true })
    vi.clearAllMocks()
  })

  /**
   * Helper: write a config file
   */
  function writeConfig(config: Partial<LinterConfig> & { rules: unknown[] }) {
    const fullConfig: LinterConfig = {
      model: 'haiku',
      concurrency: 5,
      git_base: 'main',
      ...config,
    }
    writeFileSync(
      join(tempDir, '.ai-lint.yml'),
      `model: ${fullConfig.model}
concurrency: ${fullConfig.concurrency}
git_base: ${fullConfig.git_base}
rules:
${fullConfig.rules
  .map((rule) => {
    const r = rule as {
      id: string
      name: string
      severity: string
      glob: string
      exclude?: string
      prompt: string
      model?: string
    }
    return `  - id: ${r.id}
    name: "${r.name}"
    severity: ${r.severity}
    glob: "${r.glob}"${r.exclude ? `\n    exclude: "${r.exclude}"` : ''}
    prompt: |
      ${r.prompt}${r.model ? `\n    model: ${r.model}` : ''}`
  })
  .join('\n')}`,
    )
  }

  /**
   * Helper: write a source file
   */
  function writeFile(relativePath: string, content: string) {
    writeFileSync(join(tempDir, relativePath), content)
  }

  /**
   * Helper: run the linter engine
   */
  async function runLinter(files: string[]) {
    const config = new ConfigLoader().load(join(tempDir, '.ai-lint.yml'))
    const cache = new CacheManager(join(tempDir, '.ai-lint'))
    const client = new AIClient({
      provider: config.provider,
      providerUrl: config.provider_url,
      defaultModel: config.model,
    })
    const matcher = new RuleMatcher(config.rules)
    const reporter = new Reporter()
    const engine = new LinterEngine({ cache, client, matcher, reporter })

    const result = await engine.run(files, config)
    return result.results // Return just the results array
  }

  // Test 1: Full lint run with 2 rules, 3 files, mix of pass/fail
  it('should run full lint with mix of pass/fail results', async () => {
    writeConfig({
      rules: [
        {
          id: 'no_console',
          name: 'No console.log',
          severity: 'error',
          glob: '**/*.ts',
          prompt: 'Check for console.log statements',
        },
        {
          id: 'max_length',
          name: 'Max 100 lines',
          severity: 'warning',
          glob: '**/*.ts',
          prompt: 'Check if file exceeds 100 lines',
        },
      ],
    })

    writeFile('file1.ts', "console.log('test');\n")
    writeFile('file2.ts', 'const x = 1;\n')
    writeFile('file3.ts', '// valid code\n')

    // Mock API responses
    mockGenerateText
      .mockResolvedValueOnce({
        output: { pass: false, message: 'Found console.log on line 1', line: 1 },
      })
      .mockResolvedValueOnce({
        output: { pass: false, message: 'File exceeds 100 lines', line: null },
      })
      .mockResolvedValueOnce({
        output: { pass: true, message: 'No console.log found', line: null },
      })
      .mockResolvedValueOnce({
        output: { pass: true, message: 'File is under 100 lines', line: null },
      })
      .mockResolvedValueOnce({
        output: { pass: true, message: 'No console.log found', line: null },
      })
      .mockResolvedValueOnce({
        output: { pass: true, message: 'File is under 100 lines', line: null },
      })

    const results = await runLinter([
      join(tempDir, 'file1.ts'),
      join(tempDir, 'file2.ts'),
      join(tempDir, 'file3.ts'),
    ])

    expect(results.length).toBe(6) // 3 files × 2 rules
    expect(results.filter((r) => !r.pass).length).toBe(2) // 1 error + 1 warning

    const summary = {
      errors: results.filter((r) => r.severity === 'error' && !r.pass).length,
      warnings: results.filter((r) => r.severity === 'warning' && !r.pass).length,
    }
    expect(summary.errors).toBe(1)
    expect(summary.warnings).toBe(1)
  })

  // Test 2: All pass — exit code 0
  it('should return exit code 0 when all rules pass', async () => {
    writeConfig({
      rules: [
        {
          id: 'no_console',
          name: 'No console.log',
          severity: 'error',
          glob: '**/*.ts',
          prompt: 'Check for console.log statements',
        },
      ],
    })

    writeFile('file1.ts', 'const x = 1;\n')
    writeFile('file2.ts', 'const y = 2;\n')

    mockGenerateText.mockResolvedValue({
      output: { pass: true, message: 'No console.log found', line: null },
    })

    const results = await runLinter([join(tempDir, 'file1.ts'), join(tempDir, 'file2.ts')])

    expect(results.every((r) => r.pass)).toBe(true)
    expect(results.filter((r) => r.severity === 'error' && !r.pass).length).toBe(0)
  })

  // Test 3: Only warnings — exit code 0
  it('should return exit code 0 for warnings only', async () => {
    writeConfig({
      rules: [
        {
          id: 'max_length',
          name: 'Max 100 lines',
          severity: 'warning',
          glob: '**/*.ts',
          prompt: 'Check if file exceeds 100 lines',
        },
      ],
    })

    writeFile('file1.ts', '// short file\n')

    mockGenerateText.mockResolvedValue({
      output: { pass: false, message: 'File could be shorter', line: null },
    })

    const results = await runLinter([join(tempDir, 'file1.ts')])

    expect(results.filter((r) => !r.pass).length).toBe(1)
    expect(results.filter((r) => r.severity === 'warning').length).toBe(1)
    expect(results.filter((r) => r.severity === 'error' && !r.pass).length).toBe(0)
  })

  // Test 4: Mix errors + warnings — exit code 1
  it('should return exit code 1 for mix of errors and warnings', async () => {
    writeConfig({
      rules: [
        {
          id: 'no_console',
          name: 'No console.log',
          severity: 'error',
          glob: '**/*.ts',
          prompt: 'Check for console.log statements',
        },
        {
          id: 'max_length',
          name: 'Max 100 lines',
          severity: 'warning',
          glob: '**/*.ts',
          prompt: 'Check if file exceeds 100 lines',
        },
      ],
    })

    writeFile('file1.ts', "console.log('test');\n")

    mockGenerateText
      .mockResolvedValueOnce({
        output: { pass: false, message: 'Found console.log', line: 1 },
      })
      .mockResolvedValueOnce({
        output: { pass: false, message: 'File too long', line: null },
      })

    const results = await runLinter([join(tempDir, 'file1.ts')])

    expect(results.filter((r) => r.severity === 'error' && !r.pass).length).toBe(1)
    expect(results.filter((r) => r.severity === 'warning' && !r.pass).length).toBe(1)
  })

  // Test 5: Cache hit — second run without changes
  it('should use cache on second run without changes', async () => {
    writeConfig({
      rules: [
        {
          id: 'no_console',
          name: 'No console.log',
          severity: 'error',
          glob: '**/*.ts',
          prompt: 'Check for console.log statements',
        },
      ],
    })

    writeFile('file1.ts', 'const x = 1;\n')

    mockGenerateText.mockResolvedValue({
      output: { pass: true, message: 'No console.log found', line: null },
    })

    // First run
    await runLinter([join(tempDir, 'file1.ts')])
    expect(mockGenerateText).toHaveBeenCalledTimes(1)

    // Second run — should use cache
    mockGenerateText.mockClear()
    const results = await runLinter([join(tempDir, 'file1.ts')])

    expect(mockGenerateText).toHaveBeenCalledTimes(0) // No API calls
    expect(results.length).toBe(1)
    expect(results[0].cached).toBe(true)
  })

  // Test 6: Cache invalidation — file changed
  it('should invalidate cache when file changes', async () => {
    writeConfig({
      rules: [
        {
          id: 'no_console',
          name: 'No console.log',
          severity: 'error',
          glob: '**/*.ts',
          prompt: 'Check for console.log statements',
        },
      ],
    })

    writeFile('file1.ts', 'const x = 1;\n')
    writeFile('file2.ts', 'const y = 2;\n')

    mockGenerateText.mockResolvedValue({
      output: { pass: true, message: 'No console.log found', line: null },
    })

    // First run
    await runLinter([join(tempDir, 'file1.ts'), join(tempDir, 'file2.ts')])
    expect(mockGenerateText).toHaveBeenCalledTimes(2)

    // Modify file1
    writeFile('file1.ts', 'const x = 2;\n')

    // Second run
    mockGenerateText.mockClear()
    const results = await runLinter([join(tempDir, 'file1.ts'), join(tempDir, 'file2.ts')])

    expect(mockGenerateText).toHaveBeenCalledTimes(1) // Only file1 re-linted
    expect(results.find((r) => r.file.includes('file1.ts'))?.cached).toBe(false)
    expect(results.find((r) => r.file.includes('file2.ts'))?.cached).toBe(true)
  })

  it('should run in report-only mode, suppress normal output, and write report', async () => {
    writeConfig({
      rules: [
        {
          id: 'no_console',
          name: 'No console.log',
          severity: 'error',
          glob: '**/*.ts',
          prompt: 'Check for console.log statements',
        },
      ],
    })

    writeFile('file1.ts', 'const x = 1;\n')
    const config = new ConfigLoader().load(join(tempDir, '.ai-lint.yml'))

    mockGenerateText.mockResolvedValue({
      output: { pass: true, message: 'No console.log found', line: null },
    })

    const logSpy = vi.fn()
    const consoleLogSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
    const reportPath = join(tempDir, '.ai-lint', 'report-only-report.json')

    const exitCode = await runReportOnlyLint({
      filesToLint: [join(tempDir, 'file1.ts')],
      config,
      reportFile: reportPath,
      deps: {
        cache: new CacheManager(join(tempDir, '.ai-lint')),
        client: new AIClient({
          provider: config.provider,
          providerUrl: config.provider_url,
          defaultModel: config.model,
        }),
        matcher: new RuleMatcher(config.rules),
      },
      log: logSpy,
    })

    const report = JSON.parse(readFileSync(reportPath, 'utf-8')) as {
      mode: string
      exit_code: number
      summary: { total_files: number }
      results: Array<{ pass: boolean }>
    }

    expect(exitCode).toBe(0)
    expect(report.mode).toBe('report-only')
    expect(report.exit_code).toBe(0)
    expect(report.summary.total_files).toBe(1)
    expect(report.results).toHaveLength(1)
    expect(report.results[0].pass).toBe(true)
    expect(logSpy).toHaveBeenCalledTimes(1)
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('Report written:'))
    expect(consoleLogSpy).toHaveBeenCalledTimes(0)
    consoleLogSpy.mockRestore()
  })

  // Test 7: Cache invalidation — prompt changed
  it('should invalidate cache when rule prompt changes', async () => {
    writeConfig({
      rules: [
        {
          id: 'no_console',
          name: 'No console.log',
          severity: 'error',
          glob: '**/*.ts',
          prompt: 'Check for console.log statements',
        },
      ],
    })

    writeFile('file1.ts', 'const x = 1;\n')

    mockGenerateText.mockResolvedValue({
      output: { pass: true, message: 'No console.log found', line: null },
    })

    // First run
    await runLinter([join(tempDir, 'file1.ts')])
    expect(mockGenerateText).toHaveBeenCalledTimes(1)

    // Change rule prompt
    writeConfig({
      rules: [
        {
          id: 'no_console',
          name: 'No console.log',
          severity: 'error',
          glob: '**/*.ts',
          prompt: 'Check for console.log or console.error statements', // Changed
        },
      ],
    })

    // Second run
    mockGenerateText.mockClear()
    const results = await runLinter([join(tempDir, 'file1.ts')])

    expect(mockGenerateText).toHaveBeenCalledTimes(1) // Re-linted due to prompt change
    expect(results[0].cached).toBe(false)
  })

  // Test 8: Invalid config
  it('should throw error for invalid config', () => {
    writeFileSync(
      join(tempDir, '.ai-lint.yml'),
      `model: haiku
rules:
  - id: missing_severity
    name: "Test"
    glob: "**/*.ts"
    prompt: "Test prompt"`,
    )

    expect(() => new ConfigLoader().load(join(tempDir, '.ai-lint.yml'))).toThrow()
  })

  // Test 9: No matching files
  it('should handle no matching files gracefully', async () => {
    writeConfig({
      rules: [
        {
          id: 'no_console',
          name: 'No console.log',
          severity: 'error',
          glob: '**/*.js',
          prompt: 'Check for console.log statements',
        },
      ],
    })

    writeFile('file1.ts', 'const x = 1;\n') // .ts file, rule expects .js

    const results = await runLinter([join(tempDir, 'file1.ts')])

    expect(results.length).toBe(0) // No matching rules
    expect(mockGenerateText).toHaveBeenCalledTimes(0)
  })

  // Test 10: Exclude pattern
  it('should exclude files matching exclude pattern', async () => {
    writeConfig({
      rules: [
        {
          id: 'no_console',
          name: 'No console.log',
          severity: 'error',
          glob: '**/*.ts',
          exclude: '**/*.test.ts',
          prompt: 'Check for console.log statements',
        },
      ],
    })

    writeFile('file1.ts', 'const x = 1;\n')
    writeFile('file2.test.ts', 'const y = 2;\n')

    mockGenerateText.mockResolvedValue({
      output: { pass: true, message: 'No console.log found', line: null },
    })

    const results = await runLinter([join(tempDir, 'file1.ts'), join(tempDir, 'file2.test.ts')])

    expect(results.length).toBe(1) // Only file1.ts matched
    expect(results[0].file).toContain('file1.ts')
    expect(mockGenerateText).toHaveBeenCalledTimes(1)
  })
})

describe('E2E Tests — Claude Code Provider', () => {
  let tempDir: string

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'ai-lint-e2e-claude-code-'))
    mockExecFile.mockClear()
  })

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true })
    vi.clearAllMocks()
  })

  function writeConfig(overrides: Record<string, unknown> = {}, rules: unknown[] = []) {
    const ruleList =
      rules.length > 0
        ? rules
        : [
            {
              id: 'no_console',
              name: 'No console.log',
              severity: 'error',
              glob: '**/*.ts',
              prompt: 'Check for console.log statements',
            },
          ]

    writeFileSync(
      join(tempDir, '.ai-lint.yml'),
      `provider: claude-code
${overrides.model ? `model: ${overrides.model}` : ''}
${overrides.concurrency ? `concurrency: ${overrides.concurrency}` : ''}
git_base: main
rules:
${(
  ruleList as Array<{
    id: string
    name: string
    severity: string
    glob: string
    prompt: string
    model?: string
  }>
)
  .map(
    (r) => `  - id: ${r.id}
    name: "${r.name}"
    severity: ${r.severity}
    glob: "${r.glob}"
    prompt: |
      ${r.prompt}${r.model ? `\n    model: ${r.model}` : ''}`,
  )
  .join('\n')}`,
    )
  }

  function writeFile(relativePath: string, content: string) {
    writeFileSync(join(tempDir, relativePath), content)
  }

  function simulateClaude(
    responses: Array<{ pass: boolean; message: string; line: number | null }>,
  ) {
    let callIndex = 0
    mockExecFile.mockImplementation(
      (
        _cmd: string,
        _args: string[],
        _opts: unknown,
        callback: (err: Error | null, stdout: string, stderr: string) => void,
      ) => {
        const response = responses[callIndex++] ?? responses[responses.length - 1]
        callback(
          null,
          JSON.stringify({
            session_id: `session-${callIndex}`,
            structured_output: response,
          }),
          '',
        )
        return { stdin: { end: vi.fn() } }
      },
    )
  }

  async function runLinterWithClaudeCode(files: string[]) {
    const config = new ConfigLoader().load(join(tempDir, '.ai-lint.yml'))
    const cache = new CacheManager(join(tempDir, '.ai-lint'))
    const client = new ClaudeCodeClient({
      model: config.model !== 'gemini-flash' ? config.model : undefined,
    })
    const matcher = new RuleMatcher(config.rules)
    const reporter = new Reporter()
    const engine = new LinterEngine({ cache, client, matcher, reporter })

    return engine.run(files, config)
  }

  it('should run full lint with claude-code provider — pass result', async () => {
    writeConfig()
    writeFile('file1.ts', 'const x = 1;\n')

    simulateClaude([{ pass: true, message: 'No console.log found', line: null }])

    const { results, summary, exitCode } = await runLinterWithClaudeCode([
      join(tempDir, 'file1.ts'),
    ])

    expect(results).toHaveLength(1)
    expect(results[0].pass).toBe(true)
    expect(results[0].rule_id).toBe('no_console')
    expect(results[0].cached).toBe(false)
    expect(summary.passed).toBe(1)
    expect(summary.errors).toBe(0)
    expect(exitCode).toBe(0)
  })

  it('should run full lint with claude-code provider — fail result', async () => {
    writeConfig()
    writeFile('file1.ts', "console.log('hello');\n")

    simulateClaude([{ pass: false, message: 'Found console.log on line 1', line: 1 }])

    const { results, summary, exitCode } = await runLinterWithClaudeCode([
      join(tempDir, 'file1.ts'),
    ])

    expect(results).toHaveLength(1)
    expect(results[0].pass).toBe(false)
    expect(results[0].message).toBe('Found console.log on line 1')
    expect(results[0].line).toBe(1)
    expect(summary.errors).toBe(1)
    expect(exitCode).toBe(1)
  })

  it('should handle multiple files and rules with claude-code provider', async () => {
    writeConfig({}, [
      {
        id: 'no_console',
        name: 'No console.log',
        severity: 'error',
        glob: '**/*.ts',
        prompt: 'Check for console.log statements',
      },
      {
        id: 'max_length',
        name: 'Max 100 lines',
        severity: 'warning',
        glob: '**/*.ts',
        prompt: 'Check if file exceeds 100 lines',
      },
    ])

    writeFile('file1.ts', "console.log('test');\n")
    writeFile('file2.ts', 'const x = 1;\n')

    simulateClaude([
      { pass: false, message: 'Found console.log', line: 1 },
      { pass: true, message: 'File is short', line: null },
      { pass: true, message: 'No console.log', line: null },
      { pass: true, message: 'File is short', line: null },
    ])

    const { results, summary } = await runLinterWithClaudeCode([
      join(tempDir, 'file1.ts'),
      join(tempDir, 'file2.ts'),
    ])

    expect(results).toHaveLength(4) // 2 files × 2 rules
    expect(summary.errors).toBe(1)
    expect(summary.passed).toBe(3)
    expect(mockExecFile).toHaveBeenCalledTimes(4)
  })

  it('should use cache on second run with claude-code provider', async () => {
    writeConfig()
    writeFile('file1.ts', 'const x = 1;\n')

    simulateClaude([{ pass: true, message: 'No console.log found', line: null }])

    // First run
    await runLinterWithClaudeCode([join(tempDir, 'file1.ts')])
    expect(mockExecFile).toHaveBeenCalledTimes(1)

    // Second run — should use cache
    mockExecFile.mockClear()
    const { results } = await runLinterWithClaudeCode([join(tempDir, 'file1.ts')])

    expect(mockExecFile).toHaveBeenCalledTimes(0) // No CLI calls
    expect(results).toHaveLength(1)
    expect(results[0].cached).toBe(true)
  })

  it('should handle CLI failure gracefully', async () => {
    writeConfig()
    writeFile('file1.ts', 'const x = 1;\n')

    mockExecFile.mockImplementation(
      (
        _cmd: string,
        _args: string[],
        _opts: unknown,
        callback: (err: Error | null, stdout: string, stderr: string) => void,
      ) => {
        callback(new Error('CLI crashed'), '', 'CLI crashed')
        return { stdin: { end: vi.fn() } }
      },
    )

    const { results, exitCode } = await runLinterWithClaudeCode([join(tempDir, 'file1.ts')])

    expect(results).toHaveLength(1)
    expect(results[0].pass).toBe(false)
    expect(results[0].api_error).toBe(true)
    expect(exitCode).toBe(1)
  })

  it('should load claude-code config correctly', () => {
    writeConfig({ model: 'sonnet' })
    const config = new ConfigLoader().load(join(tempDir, '.ai-lint.yml'))

    expect(config.provider).toBe('claude-code')
    expect(config.model).toBe('sonnet')
    expect(config.concurrency).toBe(1)
  })
})
