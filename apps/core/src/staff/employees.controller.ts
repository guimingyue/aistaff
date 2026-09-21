import { BadRequestException, Body, Controller, Get, Inject, Param, Patch, Query } from '@nestjs/common';
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

  @Patch('employees/:employeeNo/status')
  async changeStatus(@Param('employeeNo') employeeNo: string, @Body() body: { status?: string }) {
    const actor = 'admin-cli';
    try {
      const result = await this.staff.changeStatus(employeeNo, body?.status ?? '');
      await this.audit.record({
        actor,
        action: 'employee.status.change',
        target: employeeNo,
        detail: { status: result.status },
      });
      return result;
    } catch (err) {
      await this.audit.record({
        actor,
        action: 'employee.status.reject',
        target: employeeNo,
        detail: { requested: body?.status, reason: (err as Error).message },
      });
      throw new BadRequestException((err as Error).message);
    }
  }

  @Get('audit-events')
  async auditEvents(@Query('limit') limit?: string) {
    return this.audit.recent(limit ? Number(limit) : 50);
  }
}
