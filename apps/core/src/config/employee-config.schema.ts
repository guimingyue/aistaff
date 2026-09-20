import { z } from 'zod';

export const employeeConfigSchema = z
  .object({
    name: z.string().min(1),
    type: z.enum(['HUMAN', 'DIGITAL']),
    dept: z.string().optional(),
    reportsTo: z.string().optional(),
    guardian: z.string().optional(),
    bindings: z
      .array(
        z.object({
          provider: z.enum(['DINGTALK', 'FEISHU']),
          externalUserId: z.string().optional(),
        }),
      )
      .optional(),
    agentProfile: z
      .object({
        systemPrompt: z.string().optional(),
        model: z.string().optional(),
        tools: z.array(z.string()).optional(),
      })
      .optional(),
  })
  .superRefine((cfg, ctx) => {
    if (cfg.type === 'DIGITAL' && !cfg.guardian) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['guardian'],
        message: '数字员工必须声明 guardian（一期强制 1 个在职真人）',
      });
    }
  });

export type EmployeeConfig = z.infer<typeof employeeConfigSchema>;
