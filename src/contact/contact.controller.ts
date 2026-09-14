import { Body, Controller, Post, UseGuards } from '@nestjs/common';
import { InternalGuard } from '../auth/internal.guard.js';
import { ContactService } from './contact.service.js';

@Controller('contact')
export class ContactController {
  constructor(private readonly contacts: ContactService) {}

  @Post('submissions')
  @UseGuards(InternalGuard)
  create(@Body() body: { name?: string; email?: string; phone?: string; goal?: string }) {
    return this.contacts
      .create({
        name: body.name || '',
        email: body.email || '',
        phone: body.phone,
        goal: body.goal || '',
      })
      .then((submission) => ({ ok: true, submission }));
  }
}
