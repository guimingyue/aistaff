import { BadRequestException, Body, Controller, Get, Inject, Param, Post } from '@nestjs/common';
import { ChatService } from './chat.service';

@Controller()
export class ChatController {
  constructor(@Inject(ChatService) private readonly chatService: ChatService) {}

  @Get('employees/:employeeNo/conversations')
  async conversations(@Param('employeeNo') employeeNo: string) {
    return this.chatService.conversations(employeeNo);
  }

  @Post('employees/:employeeNo/chat')
  async chat(
    @Param('employeeNo') employeeNo: string,
    @Body() body: { message?: string; conversationId?: string; actor?: string },
  ) {
    try {
      return await this.chatService.chat(employeeNo, body?.message ?? '', {
        actor: body?.actor ?? 'admin-cli',
        conversationId: body?.conversationId,
      });
    } catch (err) {
      throw new BadRequestException((err as Error).message);
    }
  }
}
