import { Injectable, OnModuleDestroy } from '@nestjs/common';
import { PrismaClient as StaffPrismaClient } from '../generated/staff';
import { PrismaClient as SessionsPrismaClient } from '../generated/sessions';

@Injectable()
export class PrismaService implements OnModuleDestroy {
  readonly staff = new StaffPrismaClient();
  readonly sessions = new SessionsPrismaClient();

  async onModuleDestroy() {
    await this.staff.$disconnect();
    await this.sessions.$disconnect();
  }
}
