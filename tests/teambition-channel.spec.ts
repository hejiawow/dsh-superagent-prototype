/** The Teambition Channel: one comment per result, the files a result hands over, and deduplication by the text already there. */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { OutboundMessage } from '../src/core/index.ts'
import type { SourceContext } from '../src/sources/host.ts'
import { sendTeambition } from '../src/sources/teambition-channel.ts'

let dir = ''
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'tb-channel-')) })
afterEach(() => { vi.unstubAllGlobals(); rmSync(dir, { recursive: true, force: true }) })

const message = (attachments?: string[]): OutboundMessage => ({ id: 'reply:1', kind: 'reply',
  channel: { source: 'teambition', thread: 'tb:task:t1',
    address: { taskId: 't1', projectId: 'p1', cli: '/usr/local/bin/tb-agent', requesterId: 'u1', requesterName: '何佳' } },
  text: '方案已就绪。', ...(attachments ? { attachments } : {}) })

/** A Commands stand-in that records each CLI call; the deduplication read answers `existing`, every other call asks for an upload token. */
function host(existing: readonly string[] = []) {
  const calls: string[][] = []
  const tb = vi.fn(async (_schema: unknown, _cli: string, args: string[]) => {
    calls.push(args)
    if (args[1] === 'activity') {
      return { result: existing.map(text => ({ id: 'a1', action: 'comment', createTime: '2026-11-04T00:00:00.000Z', content: JSON.stringify({ comment: text }) })) }
    }
    return { result: { token: 'tok-1', uploadUrl: 'https://upload.example/one' } }
  })
  const run = vi.fn(async (_cli: string, args: string[]) => { calls.push(args); return '' })
  return { commands: { tb, run } as unknown as SourceContext['commands'], calls }
}

it('uploads the files a result hands over and posts them with its one comment', async () => {
  const plan = join(dir, 'plan.md')
  writeFileSync(plan, '# 方案\n')
  const { commands, calls } = host()
  const put = vi.fn(async () => new Response(null, { status: 200 }))
  vi.stubGlobal('fetch', put)

  expect(await sendTeambition({ commands }, message([plan]))).toBe('sent')
  expect(calls.find(args => args.includes('upload-token-create'))).toEqual(expect.arrayContaining(
    ['--task-id', 't1', '--file-name', 'plan.md', '--file-size', String(Buffer.byteLength('# 方案\n')), '--file-type', 'text/markdown']))
  expect(put).toHaveBeenCalledWith('https://upload.example/one', expect.objectContaining({ method: 'PUT' }))
  expect(calls.find(args => args[1] === 'comment')).toEqual(expect.arrayContaining(['--file-tokens', 'tok-1', '--mention', 'u1']))
  expect(calls.find(args => args[1] === 'comment')).toContain('@何佳 方案已就绪。')
})

it('deduplicates by the text already on the task, without uploading the files again', async () => {
  const plan = join(dir, 'plan.md')
  writeFileSync(plan, 'x')
  const { commands, calls } = host(['@何佳 方案已就绪。'])
  const put = vi.fn()
  vi.stubGlobal('fetch', put)

  expect(await sendTeambition({ commands }, message([plan]))).toBe('sent')
  expect(calls.some(args => args.includes('upload-token-create'))).toBe(false)
  expect(calls.some(args => args[1] === 'comment')).toBe(false)
  expect(put).not.toHaveBeenCalled()
})

it('fails the send, leaving no comment, when the upload is refused', async () => {
  const plan = join(dir, 'plan.md')
  writeFileSync(plan, 'x')
  const { commands, calls } = host()
  vi.stubGlobal('fetch', vi.fn(async () => new Response(null, { status: 403 })))

  await expect(sendTeambition({ commands }, message([plan]))).rejects.toThrow('HTTP 403')
  expect(calls.some(args => args[1] === 'comment')).toBe(false)
})