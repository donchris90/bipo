import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { sameRules, validateGameRules } from './game-rules';
import { PrismaService } from '../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import { GameStatus, RoleName } from '@prisma/client';

@Injectable()
export class GameAdminService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  async setStatus(gameCode: string, status: GameStatus, actorId: string, actorRoles: RoleName[]) {
    const game = await this.prisma.gameDefinition.findUnique({ where: { code: gameCode } });
    if (!game) throw new NotFoundException('Game not found');

    const updated = await this.prisma.gameDefinition.update({ where: { code: gameCode }, data: { status } });

    // Flipping a game to ACTIVE is a legal/compliance decision (spec §96),
    // not a routine toggle — audited distinctly from other config changes.
    await this.audit.record({
      actorId,
      actorRole: actorRoles[0],
      action: `game.status.${status.toLowerCase()}`,
      targetType: 'game_definition',
      targetId: gameCode,
    });

    return updated;
  }

  // Creates a new game or updates an existing one's name/rules — separate
  // from setStatus specifically so changing a game's payout math or dice
  // config is a distinct, audited action from flipping it live. A new game
  // is created DISABLED by default (see the schema default), never active
  // on creation — someone still has to deliberately flip it via setStatus.
  async upsert(
    gameCode: string,
    data: { name: string; minAge?: number; rulesJson?: Record<string, unknown> },
    actorId: string,
    actorRoles: RoleName[],
  ) {
    const existing = await this.prisma.gameDefinition.findUnique({ where: { code: gameCode } });

    // Validated against a strict allow-list with bounds (see game-rules.ts):
    // these numbers decide real money outcomes.
    const rules = data.rulesJson !== undefined ? validateGameRules(existing?.rulesJson, data.rulesJson) : undefined;
    const rulesChanged = rules !== undefined && !sameRules(existing?.rulesJson ?? {}, rules);
    const minAgeChanged = existing !== null && data.minAge !== undefined && data.minAge !== existing.minAge;

    if (existing && (rulesChanged || minAgeChanged)) {
      // Settlement reads the payout rules when a round settles, so changing them
      // under a live game — or under a round that is still in progress — would
      // pay some players by rules they did not bet under.
      if (existing.status === GameStatus.ACTIVE) {
        throw new ConflictException('Pause the game first (set it to Maintenance) before changing its rules or minimum age.');
      }
      const inFlight = await this.prisma.gameRound.count({
        where: { gameCode, status: { in: ['SCHEDULED', 'OPEN', 'LOCKED', 'RESOLVING'] } },
      });
      if (inFlight > 0) throw new ConflictException('A round is still in progress. Wait for it to finish, then try again.');
    }

    const game = await this.prisma.gameDefinition.upsert({
      where: { code: gameCode },
      update: {
        name: data.name,
        minAge: data.minAge,
        rulesJson: rules as any,
        // A rules change is a new version, so rounds record which rules applied.
        ...(rulesChanged ? { version: { increment: 1 } } : {}),
      },
      create: {
        code: gameCode,
        name: data.name,
        minAge: data.minAge ?? 18,
        rulesJson: rules as any,
      },
    });

    await this.audit.record({
      actorId,
      actorRole: actorRoles[0],
      action: 'game.upsert',
      targetType: 'game_definition',
      targetId: gameCode,
      metadata: { before: existing ? { name: existing.name, minAge: existing.minAge, rulesJson: existing.rulesJson } : null, after: { name: game.name, minAge: game.minAge, rulesJson: game.rulesJson } } as any,
    });
    return game;
  }

  async setRegionEnabled(gameCode: string, countryCode: string, enabled: boolean, actorId: string, actorRoles: RoleName[]) {
    const code = countryCode.toUpperCase();
    const region = await this.prisma.gameRegionConfig.upsert({
      where: { gameCode_countryCode: { gameCode, countryCode: code } },
      update: { enabled },
      create: { gameCode, countryCode: code, enabled },
    });

    await this.audit.record({
      actorId,
      actorRole: actorRoles[0],
      action: `game_region.${enabled ? 'enable' : 'disable'}`,
      targetType: 'game_region_config',
      targetId: `${gameCode}:${code}`,
    });

    return region;
  }

  listRegions(gameCode: string) {
    return this.prisma.gameRegionConfig.findMany({ where: { gameCode } });
  }
}
