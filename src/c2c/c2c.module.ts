import { Module } from '@nestjs/common';
import { C2CService } from './c2c.service';
import { C2CController } from './c2c.controller';
import { PrismaModule } from '../prisma/prisma.module';
import { AuditModule } from '../audit/audit.module';
import { EconomyModule } from '../economy/economy.module';

@Module({ imports: [PrismaModule, AuditModule, EconomyModule], providers: [C2CService], controllers: [C2CController], exports: [C2CService] })
export class C2CModule {}
