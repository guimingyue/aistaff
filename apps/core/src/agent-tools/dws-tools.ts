import { Type } from 'typebox';
import { cliIdArg, cliTextArg, runCli } from '../connections/cli-invoker';

export interface DwsToolContext {
  /** dws 可执行文件（AISTAFF_DWS_BIN，可指向验证用假 CLI） */
  bin: string;
  /** 该员工专属 CLI profile 的隔离环境 */
  env: NodeJS.ProcessEnv;
  /** 工具输出进入模型上下文前的字符上限 */
  maxOutputChars?: number;
}

const DEFAULT_MAX_OUTPUT_CHARS = 12_000;
const ERROR_DETAIL_CHARS = 300;

export const DWS_TOOL_NAMES = [
  'dws_contact_user_get',
  'dws_doc_search',
  'dws_doc_read',
  'dws_todo_create',
] as const;

/** CLI 标识符（用户 ID、文档节点 ID/URL）：整段与逐个分量都要收口，避免旗标与注入歧义。 */
function assertIdList(csv: string, flag: string, maxItems: number): string {
  const ids = csv
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  if (ids.length === 0 || ids.length > maxItems) {
    throw new Error(`${flag}: expected 1-${maxItems} identifiers, got ${ids.length}`);
  }
  for (const id of ids) {
    if (!/^[A-Za-z0-9_.:@/-]{1,256}$/.test(id)) {
      throw new Error(`${flag}: identifier "${id.slice(0, 40)}" has unsupported characters`);
    }
  }
  return ids.join(',');
}

function assertText(text: string, flag: string, maxChars: number): string {
  const trimmed = text.trim();
  if (!trimmed) throw new Error(`${flag}: must not be empty`);
  if (trimmed.length > maxChars) {
    throw new Error(`${flag}: must be at most ${maxChars} characters, got ${trimmed.length}`);
  }
  return trimmed;
}

const ISO8601 = /^\d{4}-\d{2}-\d{2}([T ]\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})?)?$/;

function truncated(text: string, max: number): { text: string; cut: boolean } {
  return text.length > max ? { text: `${text.slice(0, max)}\n…(输出已截断，共 ${text.length} 字符)`, cut: true } : { text, cut: false };
}

/**
 * pi 的 execute 契约：成功返回 content/details，失败一律抛错（结果被标记 isError）。
 * 输出不做结构假设，原样转成 JSON 文本交给模型阅读。
 */
async function execDws(ctx: DwsToolContext, args: string[], extra: string[] = []) {
  const res = await runCli(ctx.bin, [...args, ...extra, '-f', 'json'], ctx.env);
  if (res.code !== 0) {
    throw new Error(
      `dws ${args.slice(0, 2).join(' ')} failed (exit=${res.code}): ${(res.stderr || res.stdout).slice(0, ERROR_DETAIL_CHARS)}`,
    );
  }
  const max = ctx.maxOutputChars ?? DEFAULT_MAX_OUTPUT_CHARS;
  const { text, cut } = truncated(res.stdout.trim(), max);
  return {
    content: [{ type: 'text' as const, text }],
    details: { exitCode: res.code, truncated: cut },
  };
}

export function createDwsTools(ctx: DwsToolContext) {
  return [
    {
      name: 'dws_contact_user_get',
      label: 'DingTalk user lookup',
      description:
        'Look up organization members by user ID: department, title, direct manager, admin role. Requires exact user IDs; it does not search people by name.',
      promptSnippet: 'Get a DingTalk member profile (dept, manager) from exact user IDs',
      promptGuidelines: [
        'Use dws_contact_user_get only with user IDs already obtained from another source; it does not resolve person names.',
        'Never invent department or manager names: report them only when dws_contact_user_get returned them.',
      ],
      parameters: Type.Object({
        userIds: Type.String({
          description: 'Comma-separated DingTalk user IDs, 1-20 per call',
        }),
      }),
      execute: async (_toolCallId: string, params: { userIds: string }) => {
        const ids = assertIdList(params.userIds, 'userIds', 20);
        return execDws(ctx, ['contact', 'user', 'get', cliIdArg('ids', ids)]);
      },
    },
    {
      name: 'dws_doc_search',
      label: 'DingTalk doc search',
      description:
        'Search online documents in the organization by title or keyword. Returns candidate documents with node IDs; use dws_doc_read to fetch the body.',
      promptSnippet: 'Find documents by keyword, returning node IDs',
      promptGuidelines: [
        'Use dws_doc_search when only a keyword or document title is known, then dws_doc_read on the chosen node ID.',
      ],
      parameters: Type.Object({
        query: Type.String({ description: 'Search keywords, up to 200 characters' }),
        limit: Type.Optional(Type.Number({ description: 'Maximum candidates to return, 1-20, default 10' })),
      }),
      execute: async (_toolCallId: string, params: { query: string; limit?: number }) => {
        const query = assertText(params.query, 'query', 200);
        const limit = params.limit ?? 10;
        if (!Number.isInteger(limit) || limit < 1 || limit > 20) {
          throw new Error(`limit: must be an integer between 1 and 20, got ${params.limit}`);
        }
        return execDws(ctx, ['drive', '+search-docs', cliTextArg('query', query)], [
          `--limit=${limit}`,
        ]);
      },
    },
    {
      name: 'dws_doc_read',
      label: 'DingTalk doc read',
      description: 'Read one DingTalk online document as Markdown, given its document ID or URL.',
      promptSnippet: 'Read the full body of one document',
      promptGuidelines: [
        'Cite dws_doc_read output when answering from documentation, and say the document could not be read instead of guessing its content.',
      ],
      parameters: Type.Object({
        node: Type.String({ description: 'Document node ID or document URL' }),
      }),
      execute: async (_toolCallId: string, params: { node: string }) => {
        const node = assertIdList(params.node, 'node', 1);
        return execDws(ctx, ['doc', 'read', cliIdArg('node', node)]);
      },
    },
    {
      name: 'dws_todo_create',
      label: 'DingTalk todo create',
      description:
        'Create a DingTalk personal todo assigned to executor user IDs. This is a side effect on the organization: it becomes visible to the executors.',
      promptSnippet: 'Create one todo assigned to specific user IDs',
      promptGuidelines: [
        'Use dws_todo_create only for an action an organization member explicitly asked the employee to track.',
        'Before dws_todo_create, restate the todo title and the executors in the reply so the requester can notice a mistake.',
      ],
      parameters: Type.Object({
        title: Type.String({ description: 'Todo title, up to 200 characters' }),
        executorUserIds: Type.String({
          description: 'Comma-separated executor user IDs, 1-20 per todo',
        }),
        due: Type.Optional(Type.String({ description: 'Due time in ISO 8601, e.g. 2026-10-05T18:00:00Z' })),
        priority: Type.Optional(
          Type.Union([Type.Literal(10), Type.Literal(20), Type.Literal(30), Type.Literal(40)], {
            description: 'Priority: 10 low / 20 normal / 30 high / 40 urgent',
          }),
        ),
      }),
      execute: async (_toolCallId: string, params: { title: string; executorUserIds: string; due?: string; priority?: number }) => {
        const title = assertText(params.title, 'title', 200);
        const executors = assertIdList(params.executorUserIds, 'executorUserIds', 20);
        const extra: string[] = [cliTextArg('title', title), cliIdArg('executors', executors)];
        if (params.due !== undefined) {
          const due = params.due.trim();
          if (!ISO8601.test(due) || Number.isNaN(Date.parse(due))) {
            throw new Error(`due: must be a valid ISO 8601 timestamp, got "${due.slice(0, 40)}"`);
          }
          extra.push(cliIdArg('due', due));
        }
        if (params.priority !== undefined) {
          if (![10, 20, 30, 40].includes(params.priority)) {
            throw new Error(`priority: must be one of 10/20/30/40, got ${params.priority}`);
          }
          extra.push(`--priority=${params.priority}`);
        }
        return execDws(ctx, ['todo', '+create'], extra);
      },
    },
  ];
}
