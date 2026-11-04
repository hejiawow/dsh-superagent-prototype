/** Teambition outbound channel: comments on the task, deduplicated by the comment text already there. */
import { readFile } from 'node:fs/promises'
import { basename, extname } from 'node:path'
import { z } from 'zod'
import type { OutboundMessage } from '../core/index.ts'
import { CliError } from '../infra/commands.ts'
import type { SourceContext } from './host.ts'
import type { ChannelLink } from './kind.ts'
import { ActivitySchema, commentText, listOf, teambitionTaskUrl } from './teambition-trigger.ts'

const Comments = listOf(ActivitySchema)
/** The comment API has no idempotency key, so a retry looks for the same text among the task's newest comments first. */
async function posted(commands: SourceContext['commands'], cli: string, taskId: string, text: string): Promise<boolean> {
  const page = await commands.tb(Comments, cli, ['task', 'activity', '--task-id', taskId, '--actions', 'comment', '--page-size', '20'])
  return page.result.some(activity => commentText(activity).trim() === text.trim())
}
/** True when Teambition no longer accepts comments on the task, such as a deleted one. */
const gone = (error: unknown): boolean =>
  error instanceof CliError && /not found|not exist|不存在|已删除|无权限|forbidden/i.test(error.message)
/** The envelope of `task upload-token-create`, whose token a comment attaches a file by. */
const Upload = z.looseObject({ result: z.looseObject({ token: z.string().min(1), uploadUrl: z.string().min(1) }) })
/** Content types of the files a result commonly hands over; anything else goes as bytes. */
const TYPES: Record<string, string> = {
  md: 'text/markdown', markdown: 'text/markdown', txt: 'text/plain', html: 'text/html', csv: 'text/csv', json: 'application/json',
  pdf: 'application/pdf', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', svg: 'image/svg+xml',
  zip: 'application/zip', doc: 'application/msword', docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xls: 'application/vnd.ms-excel', xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  ppt: 'application/vnd.ms-powerpoint', pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
}
/**
 * Uploads one handover file under the task's scope and answers the token a comment attaches it by.
 * The signed URL signs an empty Content-Type, so the upload sends none; a header would break its signature.
 */
async function upload(commands: SourceContext['commands'], cli: string, taskId: string, path: string): Promise<string> {
  const bytes = await readFile(path)
  const name = basename(path)
  const type = TYPES[extname(name).slice(1).toLowerCase()] ?? 'application/octet-stream'
  const answer = await commands.tb(Upload, cli, ['task', 'upload-token-create', '--task-id', taskId, '--file-name', name,
    '--file-size', String(bytes.length), '--file-type', type])
  const response = await fetch(answer.result.uploadUrl, { method: 'PUT', body: bytes })
  if (!response.ok) throw new CliError(`Teambition refused the attachment upload (HTTP ${response.status})`, response.status)
  return answer.result.token
}
/**
 * Comments on the task and mentions the person who asked, so Teambition notifies them.
 * Teambition shows a mention only when the content carries it, so the name goes into the text as well as the argument.
 */
export async function sendTeambition(host: Pick<SourceContext, 'commands'>, message: OutboundMessage): Promise<'sent' | 'gone'> {
  const { taskId = '', cli = '', requesterId = '', requesterName = '' } = message.channel.address
  if (!taskId || !cli) throw new Error('Missing Teambition reply target')
  const mention = !!requesterId && !!requesterName && !message.text.includes(`@${requesterName}`)
  const text = mention ? `@${requesterName} ${message.text}` : message.text
  if (await posted(host.commands, cli, taskId, text)) return 'sent'
  // Upload only once the comment is known to be absent, so a retry that only deduplicates never uploads again.
  const tokens: string[] = []
  for (const path of message.attachments ?? []) tokens.push(await upload(host.commands, cli, taskId, path))
  const args = ['task', 'comment', '--task-id', taskId, '--content', text, '--render-mode', 'markdown']
  if (mention) args.push('--mention', requesterId)
  if (tokens.length) args.push('--file-tokens', tokens.join(','))
  try { await host.commands.run(cli, args) }
  catch (error) {
    if (gone(error)) return 'gone'
    throw error
  }
  return 'sent'
}
/** Deep link to the task, which every reply and result belongs to. */
export const teambitionLink = (address: Record<string, string>): ChannelLink => ({
  url: teambitionTaskUrl(address.taskId ?? ''), label: { zh: 'Teambition 任务', en: 'Teambition task' },
})
