import { Module } from '@nestjs/common';
import { StaffService } from './staff.service';
import { EmployeesController } from './employees.controller';

@Module({
  providers: [StaffService],
  exports: [StaffService],
  controllers: [EmployeesController],
})
export class StaffModule {}
