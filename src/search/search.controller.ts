import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { SearchService } from './search.service';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';

@Controller('api/v1/search')
@UseGuards(JwtAuthGuard)
export class SearchController {
  constructor(private readonly search: SearchService) {}

  @Get('users')
  users(@Query('q') q: string) {
    return this.search.searchUsers(q ?? '');
  }
}
