import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ClaudeCodeClient } from './claude-code-client.js'
import type { LintJob } from './types.js'

// Mock child_process.execFile
const mockExecFile = vi.fn()
vi.mock('node:child_process', () => ({
  execFile: (...args: unknown[]) => mockExecFile(...args),
}))

const createMockJob = (overrides?: Partial<LintJob>): LintJob => ({
  rule: {
    id: 'test_rule',
    name: 'Test Rule',
    severity: 'error',
    glob: '**/*.ts',
    prompt: 'Check if the file is valid',
    ...overrides?.rule,
  },
  filePath: 'src/test.ts',
  fileContent: 'console.log("test")',
  fileHash: 'abc123',
  promptHash: 'def456',
  ...overrides,
})

function simulateExecFile(stdout: string, stderr = '', exitCode: number | null = 0) {
  mockExecFile.mockImplementation(
    (
      _cmd: string,
      _args: string[],
      _opts: unknown,
      callback: (err: Error | null, stdout: string, stderr: string) => void,
    ) => {
      if (exitCode !== 0) {
        const err = new Error(stderr || `Process exited with code ${exitCode}`)
        callback(err, stdout, stderr)
      } else {
        callback(null, stdout, stderr)
      }
      return { stdin: { end: vi.fn() } }
    },
  )
}

describe('ClaudeCodeClient', () => {
  let client: ClaudeCodeClient

  beforeEach(() => {
    vi.clearAllMocks()
    client = new ClaudeCodeClient()
  })

  it('should return pass=true when structured_output indicates compliance', async () => {
    const response = {
      session_id: 'test-session',
      structured_output: {
        pass: true,
        message: 'File complies with the rule',
        line: null,
      },
      result: '',
    }
    simulateExecFile(JSON.stringify(response))

    const result = await client.lint(createMockJob())

    expect(result).toMatchObject({
      rule_id: 'test_rule',
      rule_name: 'Test Rule',
      file: 'src/test.ts',
      severity: 'error',
      pass: true,
      message: 'File complies with the rule',
      cached: false,
    })
    expect(result.line).toBeUndefined()
    expect(result.duration_ms).toBeGreaterThanOrEqual(0)
  })

  it('should return pass=false with line number when violation found', async () => {
    const response = {
      session_id: 'test-session',
      structured_output: {
        pass: false,
        message: 'Found console.log on line 1',
        line: 1,
      },
    }
    simulateExecFile(JSON.stringify(response))

    const result = await client.lint(createMockJob())

    expect(result.pass).toBe(false)
    expect(result.message).toBe('Found console.log on line 1')
    expect(result.line).toBe(1)
  })

  it('should pass correct CLI arguments', async () => {
    const response = {
      structured_output: { pass: true, message: 'OK', line: null },
    }
    simulateExecFile(JSON.stringify(response))

    await client.lint(createMockJob())

    expect(mockExecFile).toHaveBeenCalledTimes(1)
    const [cmd, args] = mockExecFile.mock.calls[0]
    expect(cmd).toBe('claude')
    expect(args).toContain('-p')
    expect(args).toContain('--output-format')
    expect(args).toContain('json')
    expect(args).toContain('--json-schema')
    expect(args).toContain('--system-prompt')
    expect(args).toContain('--max-turns')
    expect(args).toContain('10')
    expect(args).toContain('--tools')
    expect(args).toContain('Read')
  })

  it('should include rule name, prompt, and file content in the prompt argument', async () => {
    const response = {
      structured_output: { pass: true, message: 'OK', line: null },
    }
    simulateExecFile(JSON.stringify(response))

    const job = createMockJob({
      rule: {
        id: 'custom_rule',
        name: 'Custom Rule Name',
        severity: 'warning',
        glob: '**/*.ts',
        prompt: 'Custom prompt text',
      },
      fileContent: 'const x = 42;',
    })

    await client.lint(job)

    const [, args] = mockExecFile.mock.calls[0]
    const promptIdx = args.indexOf('-p')
    const prompt = args[promptIdx + 1]
    expect(prompt).toContain('Custom Rule Name')
    expect(prompt).toContain('Custom prompt text')
    expect(prompt).toContain('src/test.ts')
  })

  it('should pass --model flag when model is configured', async () => {
    client = new ClaudeCodeClient({ model: 'sonnet' })
    const response = {
      structured_output: { pass: true, message: 'OK', line: null },
    }
    simulateExecFile(JSON.stringify(response))

    await client.lint(createMockJob())

    const [, args] = mockExecFile.mock.calls[0]
    expect(args).toContain('--model')
    expect(args).toContain('sonnet')
  })

  it('should use per-rule model override', async () => {
    client = new ClaudeCodeClient({ model: 'haiku' })
    const response = {
      structured_output: { pass: true, message: 'OK', line: null },
    }
    simulateExecFile(JSON.stringify(response))

    const job = createMockJob({
      rule: {
        id: 'test_rule',
        name: 'Test Rule',
        severity: 'error',
        glob: '**/*.ts',
        prompt: 'Check the file',
        model: 'opus',
      },
    })

    await client.lint(job)

    const [, args] = mockExecFile.mock.calls[0]
    expect(args).toContain('--model')
    expect(args).toContain('opus')
  })

  it('should not pass --model flag when no model is configured', async () => {
    const response = {
      structured_output: { pass: true, message: 'OK', line: null },
    }
    simulateExecFile(JSON.stringify(response))

    await client.lint(createMockJob())

    const [, args] = mockExecFile.mock.calls[0]
    expect(args).not.toContain('--model')
  })

  it('should return api_error when CLI process fails', async () => {
    simulateExecFile('', 'Some error occurred', 1)

    const result = await client.lint(createMockJob())

    expect(result.pass).toBe(false)
    expect(result.api_error).toBe(true)
    expect(result.message).toContain('Claude Code CLI error')
  })

  it('should throw descriptive error when claude CLI is not found (ENOENT)', async () => {
    mockExecFile.mockImplementation(
      (_cmd: string, _args: string[], _opts: unknown, callback: (err: Error | null) => void) => {
        const err = new Error('spawn claude ENOENT') as NodeJS.ErrnoException
        err.code = 'ENOENT'
        callback(err)
        return { stdin: { end: vi.fn() } }
      },
    )

    await expect(client.lint(createMockJob())).rejects.toThrow('Claude Code CLI not found')
  })

  it('should return api_error when CLI returns invalid JSON', async () => {
    simulateExecFile('not valid json at all')

    const result = await client.lint(createMockJob())

    expect(result.pass).toBe(false)
    expect(result.api_error).toBe(true)
    expect(result.message).toContain('Claude Code CLI error')
  })

  it('should return api_error when structured_output is missing', async () => {
    simulateExecFile(JSON.stringify({ result: 'just text, no structured output' }))

    const result = await client.lint(createMockJob())

    expect(result.pass).toBe(false)
    expect(result.api_error).toBe(true)
    expect(result.message).toContain('no structured output')
  })

  it('should fallback to parsing result field as JSON', async () => {
    const response = {
      result: JSON.stringify({ pass: true, message: 'Parsed from result', line: 5 }),
    }
    simulateExecFile(JSON.stringify(response))

    const result = await client.lint(createMockJob())

    expect(result.pass).toBe(true)
    expect(result.message).toBe('Parsed from result')
    expect(result.line).toBe(5)
  })

  it('should include system prompt with linter instructions', async () => {
    const response = {
      structured_output: { pass: true, message: 'OK', line: null },
    }
    simulateExecFile(JSON.stringify(response))

    await client.lint(createMockJob())

    const [, args] = mockExecFile.mock.calls[0]
    const systemPromptIdx = args.indexOf('--system-prompt')
    const systemPrompt = args[systemPromptIdx + 1]
    expect(systemPrompt).toContain('code linter')
    expect(systemPrompt).toContain('pass=true')
    expect(systemPrompt).toContain('pass=false')
  })
})
