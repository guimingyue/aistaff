import { BadRequestException, Body, Controller, Get, Inject, Param, Post } from '@nestjs/common';
import { MessageLoopService } from './message-loop.service';

@Controller()
export class MessageLoopController {
  constructor(@Inject(MessageLoopService) private readonly loops: MessageLoopService) {}

  @Get('loops')
  list() {
    return this.loops.status();
  }

  @Post('employees/:employeeNo/loop/start')
  async start(@Param('employeeNo') employeeNo: string, @Body() body: { actor?: string }) {
    return this.guard(() => this.loops.start(employeeNo, body?.actor ?? 'admin-cli'));
  }

  @Post('employees/:employeeNo/loop/stop')
  async stop(@Param('employeeNo') employeeNo: string, @Body() body: { actor?: string }) {
    return this.guard(() => this.loops.stop(employeeNo, body?.actor ?? 'admin-cli'));
  }

  private async guard<T>(fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (err) {
      throw new BadRequestException((err as Error).message);
    }
  }
}
