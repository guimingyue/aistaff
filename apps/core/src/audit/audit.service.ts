import { Injectable, OnModuleDestroy } from '@nestjs/common';
import { PrismaClient } from '../generated/audit';

export interface AuditRecord {
  actor: string;
  action: string;
  target: string;
  detail?: unknown;
}

@Injectable()
export class AuditService implements OnModuleDestroy {
  private readonly client = new PrismaClient();

  async record(event: AuditRecord): Promise<void> {
    await this.client.auditEvent.create({
      data: {
        actor: event.actor,
        action: event.action,
        target: event.target,
        detail: event.detail === undefined ? null : JSON.stringify(event.detail),
      },
    });
  }

  async recent(limit = 50) {
    return this.client.auditEvent.findMany({
      orderBy: { id: 'desc' },
      take: Math.min(Math.max(limit, 1), 500),
    });
  }

  async onModuleDestroy() {
    await this.client.$disconnect();
  }
}
