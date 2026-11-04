/** Teambition source kind definition, policy synchronization, and Cordis plugin entry. */
import type { Context } from '@deepseek-ai/cordis'
import { z } from 'zod'
import { sendTeambition, teambitionLink } from './teambition-channel.ts'
import { runTeambition, syncMembers } from './teambition-loops.ts'
import { teambitionThreadContext } from './teambition-read.ts'
import { SOURCE, teambitionTaskUrl, teambitionThread } from './teambition-trigger.ts'
import { sourceContext } from './host.ts'
import type { SourceKind } from './kind.ts'
import type { SourceRegistry } from './registry.ts'

/** A watched project: where its comments are read, whether unaddressed ones are received, and the status a finished Ticket moves it to. */
const ProjectSchema = z.object({
  projectId: z.string().regex(/^[0-9a-f]{24}$/),
  name: z.string().trim().max(80).optional(),
  listen: z.enum(['mentions', 'all']).default('mentions'),
  doneTfsId: z.string().regex(/^([0-9a-f]{24})?$/).optional(),
}).strict()
export const TeambitionConfigSchema = z.object({
  cli: z.string().trim().default(''),
  projects: z.array(ProjectSchema)
    .refine(projects => new Set(projects.map(project => project.projectId)).size === projects.length, 'Duplicate project ids')
    .default([]),
  pollSeconds: z.number().int().min(60).max(900).default(60),
  readPageSize: z.number().int().min(1).max(50).default(20),
}).strict()
export type TeambitionConfig = z.infer<typeof TeambitionConfigSchema>
type Project = z.infer<typeof ProjectSchema>

export const teambitionKind: SourceKind<TeambitionConfig> = {
  kind: SOURCE,
  title: { zh: 'Teambition', en: 'Teambition' },
  description: { zh: '接收下列项目中 @ 这个账号的评论和被指派给它的任务，回复写回同一个任务。', en: 'Receives comments that mention the account and tasks assigned to it in these projects, and replies on the same task.' },
  schema: TeambitionConfigSchema,
  fields: [
    { key: 'cli', type: 'text', label: { zh: '账号的 teambition-cli', en: 'The account\'s teambition-cli' },
      hint: { zh: '命令名或绝对路径，指向只登录了专用账号的配置（teambition-cli --config ~/.config/teambition-mcp-agent/config.json）。执行器和这个来源都以它行事。', en: 'A command name or absolute path of a teambition-cli configuration that holds only the dedicated account; the Executor and this Source act as it.' } },
    { key: 'projects', type: 'rows', label: { zh: '接收的项目', en: 'Projects' },
      hint: { zh: '“仅 @”只接收 @ 这个账号的评论；“全部评论”也接收其余评论，评估可以按规则从中推断工作。', en: '"@ only" receives comments that mention the account; "All comments" also receives the rest, from which Eval may infer work under the rules.' },
      columns: [
        { key: 'projectId', type: 'text', label: { zh: '项目', en: 'Project' }, pattern: '[0-9a-f]{24}' },
        { key: 'name', type: 'text', label: { zh: '名字', en: 'Name' }, optional: true },
        { key: 'listen', type: 'select', label: { zh: '接收', en: 'Receive' },
          options: [{ value: 'mentions', label: { zh: '仅 @', en: '@ only' } }, { value: 'all', label: { zh: '全部评论', en: 'All comments' } }] },
        { key: 'doneTfsId', type: 'text', pattern: '([0-9a-f]{24})?', label: { zh: '完成时移到状态', en: 'Status when done' }, optional: true },
      ] },
    { key: 'pollSeconds', type: 'number', advanced: true, min: 60, max: 900, label: { zh: '轮询间隔 / 秒', en: 'Poll interval / s' },
      hint: { zh: '两轮读取之间至少等待的时间；延迟等于这个值。', en: 'Least time between two rounds; latency equals it.' } },
    { key: 'readPageSize', type: 'number', advanced: true, min: 1, max: 50, label: { zh: '每页动态数', en: 'Activity per page' },
      hint: { zh: '智能体读取任务动态时每页的条数。', en: 'Activity per page when agents read a task.' } },
  ],
  health: ['teambition'],
  scope({ meta }, config) {
    const project = config.projects.find(item => item.projectId === String(meta.projectId ?? ''))
    if (!project) return { listened: false, reason: 'project_not_allowed' }
    if (meta.kind === 'assignment') return { listened: true, observed: false, row: 'assignments' }
    return { listened: true, observed: project.listen === 'all', row: project.projectId }
  },
  // A reply goes only to a project this Source still watches.
  channel: {
    allowed: (address, config) => config.projects.some(project => project.projectId === address.projectId),
    send: sendTeambition, link: teambitionLink,
  },
  threadContext: teambitionThreadContext,
  find: query => {
    const ids = [...new Set(query.match(/\b[0-9a-f]{24}\b/g) ?? [])]
    return { threads: ids.map(id => `teambition:${teambitionThread(id)}`), terms: ids }
  },
  policy: {
    unnamed: { person: { zh: 'Teambition 成员', en: 'Teambition member' }, bot: { zh: 'Teambition 机器人', en: 'Teambition bot' } },
    schema: z.object({
      allowed: z.array(z.object({ id: z.string().regex(/^[0-9a-f]{24}$/), name: z.string().trim().max(100).optional() }).strict())
        .refine(people => new Set(people.map(person => person.id)).size === people.length, 'Duplicate user ids').default([]),
      syncProject: z.string().regex(/^([0-9a-f]{24})?$/).default(''),
    }).strict(),
    fields: [
      { key: 'allowed', type: 'rows', label: { zh: '能发起工作的 Teambition 成员', en: 'Teambition members who may originate work' },
        columns: [{ key: 'id', type: 'text', label: { zh: '用户 ID', en: 'User id' }, pattern: '[0-9a-f]{24}' },
          { key: 'name', type: 'text', label: { zh: '名字', en: 'Name' }, optional: true }] },
      { key: 'syncProject', type: 'text', pattern: '([0-9a-f]{24})?', label: { zh: '同步来源项目', en: 'Sync project' }, choose: { zh: '不同步', en: 'Do not sync' },
        hint: { zh: '同步时，名单变成这个项目的成员；启动时和点同步时进行。', en: 'Syncing makes the list the members of this project; it runs at startup and on Sync.' } },
    ],
    explicit: { zh: '名单内的人在评论里 @ 这个账号或把任务指派给它，总是明确的请求；不需要配置。', en: 'Someone on the list who mentions the account in a comment, or assigns a task to it, always makes an explicit request; that needs no setting.' },
    rows(stored) {
      const config = TeambitionConfigSchema.parse(stored)
      const mentions = { zh: '仅 @', en: '@ only' }
      return [
        ...config.projects.map(project => ({ id: project.projectId, label: project.name || project.projectId,
          note: project.listen === 'all' ? { zh: '全部评论', en: 'All comments' } : mentions,
          cells: { listedUnaddressed: project.listen === 'all', unlistedAddressed: true, unlistedUnaddressed: project.listen === 'all' } })),
        { id: 'assignments', label: { zh: '指派给它', en: 'Assigned to it' }, note: { zh: '任务被指派给这个账号', en: 'The task was assigned to the account' },
          cells: { listedUnaddressed: false, unlistedAddressed: true, unlistedUnaddressed: false } },
      ]
    },
    sync: {
      label: { zh: '立即同步', en: 'Sync now' },
      ready: part => !!part.syncProject,
      async run(host, part, signal) {
        const ctx = sourceContext(host, teambitionKind)
        const members = await syncMembers(ctx, String(part.syncProject), signal)
        // Keep the stored order so the policy version hash stays stable across syncs.
        const known = new Map(part.allowed.map(person => [person.id, person]))
        return { ...part, allowed: members.map(member => known.get(member.id) ?? { id: member.id }) }
      },
    },
  },
  environment: {
    variables: [
      { key: 'DSH_SUPERAGENT_TEAMBITION_TASK', description: { zh: '接下工单的 Teambition 任务 ID', en: 'The Teambition task that started the ticket' } },
      { key: 'DSH_SUPERAGENT_TEAMBITION_PROJECT', description: { zh: '该任务所在的项目 ID', en: 'The project of that task' } },
      { key: 'DSH_SUPERAGENT_TEAMBITION_TASK_URL', description: { zh: '该任务的链接', en: 'The task\'s URL' } },
      { key: 'DSH_SUPERAGENT_TEAMBITION_DONE', description: { zh: '工单完成后该任务应流转到的状态 ID（tfsId）；项目没有配置时为空，此时由人改状态', en: 'Status id (tfsId) a finished ticket moves the task to; empty when the project names none, and then a person changes it' } },
    ],
    values: ({ config, trigger }) => {
      const taskId = String(trigger?.source === SOURCE ? trigger.meta.taskId ?? '' : '')
      const projectId = String(trigger?.source === SOURCE ? trigger.meta.projectId ?? '' : '')
      const project: Project | undefined = config.projects.find(item => item.projectId === projectId)
      return { DSH_SUPERAGENT_TEAMBITION_TASK: taskId, DSH_SUPERAGENT_TEAMBITION_PROJECT: projectId,
        DSH_SUPERAGENT_TEAMBITION_TASK_URL: taskId ? teambitionTaskUrl(taskId) : '',
        DSH_SUPERAGENT_TEAMBITION_DONE: project?.doneTfsId ?? '' }
    },
  },
}
/** Returns the Teambition Source's settings, falling back to schema defaults while its plugin is disabled. */
export const teambitionSettings = (sources: SourceRegistry): TeambitionConfig => sources.instance<TeambitionConfig>(SOURCE)?.config ?? TeambitionConfigSchema.parse({})

export const name = 'dsh-superagent-teambition'
export const inject = ['orchestrator']
export function apply(ctx: Context): void {
  ctx.effect(() => ctx.orchestrator.sources.register(teambitionKind), 'teambition: source kind')
  ctx.effect(() => {
    const controller = new AbortController()
    const running = runTeambition(sourceContext(ctx.orchestrator, teambitionKind), controller.signal)
    return async () => { controller.abort(); await running }
  })
}
