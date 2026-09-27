import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Inject,
  Param,
  Post,
  Query,
} from '@nestjs/common';
import { ConnectionsService } from './connections.service';

@Controller()
export class ConnectionsController {
  constructor(@Inject(ConnectionsService) private readonly connections: ConnectionsService) {}

  @Post('employees/:employeeNo/login')
  async login(
    @Param('employeeNo') employeeNo: string,
    @Body() body: { provider?: string; profile?: string },
  ) {
    const provider = body?.provider ?? 'DINGTALK';
    return this.connections.login(employeeNo, provider, 'admin-cli', body?.profile);
  }

  @Post('employees/:employeeNo/bind')
  async bind(
    @Param('employeeNo') employeeNo: string,
    @Body() body: { provider?: string; externalUserId?: string },
  ) {
    if (!body?.provider || !body?.externalUserId) {
      throw new BadRequestException('missing provider or externalUserId');
    }
    if (!['DINGTALK', 'FEISHU'].includes(body.provider)) {
      throw new BadRequestException(`unknown provider ${body.provider}`);
    }
    try {
      return await this.connections.bind(
        {
          employeeNo,
          provider: body.provider as 'DINGTALK' | 'FEISHU',
          externalUserId: body.externalUserId,
        },
        'admin-cli',
      );
    } catch (err) {
      throw new BadRequestException((err as Error).message);
    }
  }

  @Get('employees/:employeeNo/connections')
  async status(
    @Param('employeeNo') employeeNo: string,
    @Query('provider') provider?: string,
  ) {
    return this.connections.status(employeeNo, provider);
  }
}
