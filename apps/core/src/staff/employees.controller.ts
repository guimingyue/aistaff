import { Controller, Get, Inject, Query } from '@nestjs/common';
import { StaffService } from './staff.service';
import { AuditService } from '../audit/audit.service';

@Controller()
export class EmployeesController {
  constructor(
    @Inject(StaffService) private readonly staff: StaffService,
    @Inject(AuditService) private readonly audit: AuditService,
  ) {}

  @Get('employees')
  async employees() {
    return this.staff.list();
  }

  @Get('audit-events')
  async auditEvents(@Query('limit') limit?: string) {
    return this.audit.recent(limit ? Number(limit) : 50);
  }
}
