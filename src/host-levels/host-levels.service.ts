import { BadRequestException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { RoleName } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';

@Injectable()
export class HostLevelsService {
  constructor(private readonly prisma: PrismaService, private readonly audit: AuditService) {}

  async list() {
    return this.prisma.hostLevel.findMany({ orderBy: { level: 'asc' } });
  }

  async rules() {
    return this.prisma.hostXpRule.findMany({ orderBy: { key: 'asc' } });
  }

  async progress(userId: string) {
    const [user, levels] = await Promise.all([
      this.prisma.user.findUnique({ where: { id: userId }, select: { hostXp: true, hostLevel: true } }),
      this.prisma.hostLevel.findMany({ where: { active: true }, orderBy: { level: 'asc' } }),
    ]);
    if (!user) throw new NotFoundException('User not found');
    const current = [...levels].reverse().find((l) => l.xpRequired <= user.hostXp) ?? levels[0] ?? { level: 1, name: 'New Host', xpRequired: 0, unlocks: ['SOLO_LIVE'], badgeUrl: null };
    const next = levels.find((l) => l.xpRequired > user.hostXp) ?? null;
    return {
      xp: user.hostXp,
      level: current.level,
      name: current.name,
      badgeUrl: current.badgeUrl,
      unlocks: Array.isArray(current.unlocks) ? current.unlocks.map(String) : [],
      nextLevel: next ? { level: next.level, name: next.name, xpRequired: next.xpRequired } : null,
      progressXp: next ? Math.max(0, user.hostXp - current.xpRequired) : 0,
      requiredForNext: next ? Math.max(0, next.xpRequired - current.xpRequired) : 0,
      remainingXp: next ? Math.max(0, next.xpRequired - user.hostXp) : 0,
    };
  }

  async assertUnlock(userId: string, feature: string) {
    const p = await this.progress(userId);
    const unlocked = Array.isArray(p.unlocks) ? p.unlocks.map((x) => String(x)) : [];
    if (!unlocked.includes(feature)) {
      const levels = await this.prisma.hostLevel.findMany({ where: { active: true }, orderBy: { level: 'asc' } });
      const required = levels.find((l) => Array.isArray(l.unlocks) && (l.unlocks as any[]).map(String).includes(feature));
      throw new ForbiddenException(required ? `Reach Host Level ${required.level} to unlock this feature` : 'This host feature is not available yet');
    }
    return p;
  }

  async addXp(userId: string, amount: number) {
    const safe = Math.floor(Number(amount));
    if (!Number.isFinite(safe) || safe <= 0) return this.progress(userId);
    const levels = await this.prisma.hostLevel.findMany({ where: { active: true }, orderBy: { level: 'asc' } });
    const user = await this.prisma.user.update({ where: { id: userId }, data: { hostXp: { increment: safe } }, select: { hostXp: true } });
    const level = [...levels].reverse().find((l) => l.xpRequired <= user.hostXp)?.level ?? 1;
    await this.prisma.user.update({ where: { id: userId }, data: { hostLevel: level } });
    return this.progress(userId);
  }

  async awardRule(userId: string, key: string, units: number) {
    const [rule, user] = await Promise.all([
      this.prisma.hostXpRule.findUnique({ where: { key } }),
      this.prisma.user.findUnique({ where: { id: userId }, select: { roles: { select: { role: true } } } }),
    ]);
    if (!user?.roles.some((r) => r.role === 'CREATOR')) return this.progress(userId);
    if (!rule?.enabled) return this.progress(userId);
    const safeUnits = Math.floor(Number(units));
    if (!Number.isFinite(safeUnits) || safeUnits <= 0) return this.progress(userId);
    try { await this.updateDailyTasks(userId, key, safeUnits); } catch { /* task progression must never block host activity */ }
    return this.addXp(userId, safeUnits * rule.xpPerUnit);
  }

  async dailyTasks(userId: string) {
    const start = new Date();
    start.setHours(0, 0, 0, 0);
    const tasks = await this.prisma.hostDailyTask.findMany({ where: { active: true }, orderBy: { key: 'asc' } });
    const progress = await this.prisma.hostDailyTaskProgress.findMany({ where: { userId, day: start } });
    const byTask = new Map(progress.map((p) => [p.taskId, p]));
    return tasks.map((task) => {
      const row = byTask.get(task.id);
      const value = Math.min(task.targetUnits, row?.progress ?? 0);
      return { id: task.id, key: task.key, label: task.label, activityKey: task.activityKey, targetUnits: task.targetUnits, rewardXp: task.rewardXp, progress: value, completed: !!row?.completedAt || value >= task.targetUnits, completedAt: row?.completedAt ?? null };
    });
  }

  async updateDailyTasks(userId: string, activityKey: string, units: number) {
    const safeUnits = Math.floor(Number(units));
    if (!Number.isFinite(safeUnits) || safeUnits <= 0) return;
    const start = new Date();
    start.setHours(0, 0, 0, 0);
    const tasks = await this.prisma.hostDailyTask.findMany({ where: { active: true, activityKey } });
    for (const task of tasks) {
      const existing = await this.prisma.hostDailyTaskProgress.findUnique({ where: { userId_taskId_day: { userId, taskId: task.id, day: start } } });
      if (existing?.completedAt) continue;
      const next = Math.min(task.targetUnits, (existing?.progress ?? 0) + safeUnits);
      const completed = next >= task.targetUnits;
      await this.prisma.hostDailyTaskProgress.upsert({
        where: { userId_taskId_day: { userId, taskId: task.id, day: start } },
        update: { progress: next, completedAt: completed ? (existing?.completedAt ?? new Date()) : null },
        create: { userId, taskId: task.id, day: start, progress: next, completedAt: completed ? new Date() : null },
      });
      if (completed && !existing?.completedAt && task.rewardXp > 0) {
        await this.addXp(userId, task.rewardXp);
      }
    }
  }

  async updateTask(key: string, body: any, actorId: string, roles: RoleName) {
    const task = await this.prisma.hostDailyTask.findUnique({ where: { key } });
    if (!task) throw new NotFoundException('Daily task not found');
    const targetUnits = Math.floor(Number(body.targetUnits));
    const rewardXp = Math.floor(Number(body.rewardXp));
    if (!Number.isFinite(targetUnits) || targetUnits < 1 || targetUnits > 10000000) throw new BadRequestException('targetUnits must be between 1 and 10000000');
    if (!Number.isFinite(rewardXp) || rewardXp < 0 || rewardXp > 100000) throw new BadRequestException('rewardXp must be between 0 and 100000');
    const updated = await this.prisma.hostDailyTask.update({ where: { key }, data: { label: String(body.label ?? task.label).trim().slice(0, 120), targetUnits, rewardXp, active: body.active !== false } });
    await this.audit.record({ actorId, actorRole: roles, action: 'host_daily_task.update', targetType: 'host_daily_task', targetId: key, metadata: { targetUnits, rewardXp, active: updated.active } });
    return updated;
  }

  async listTasks() { return this.prisma.hostDailyTask.findMany({ orderBy: { key: 'asc' } }); }

  async updateLevel(level: number, body: any, actorId: string, roles: RoleName[]) {
    if (!Number.isInteger(level) || level < 1 || level > 100) throw new BadRequestException('Level must be between 1 and 100');
    const xpRequired = Math.floor(Number(body.xpRequired));
    if (!Number.isFinite(xpRequired) || xpRequired < 0) throw new BadRequestException('xpRequired must be a non-negative number');
    const name = String(body.name ?? '').trim();
    if (!name || name.length > 60) throw new BadRequestException('Level name is required and must be 60 characters or less');
    const updated = await this.prisma.hostLevel.upsert({
      where: { level },
      update: { name, xpRequired, unlocks: Array.isArray(body.unlocks) ? body.unlocks : [], badgeUrl: body.badgeUrl ? String(body.badgeUrl) : null, active: body.active !== false },
      create: { level, name, xpRequired, unlocks: Array.isArray(body.unlocks) ? body.unlocks : [], badgeUrl: body.badgeUrl ? String(body.badgeUrl) : null, active: body.active !== false },
    });
    await this.audit.record({ actorId, actorRole: roles[0], action: 'host_level.update', targetType: 'host_level', targetId: String(level), metadata: { xpRequired, name } });
    return updated;
  }

  async updateRule(key: string, body: any, actorId: string, roles: RoleName) {
    const existing = await this.prisma.hostXpRule.findUnique({ where: { key } });
    if (!existing) throw new NotFoundException('XP rule not found');
    const xpPerUnit = Math.floor(Number(body.xpPerUnit));
    if (!Number.isFinite(xpPerUnit) || xpPerUnit < 0 || xpPerUnit > 10000) throw new BadRequestException('xpPerUnit must be between 0 and 10000');
    const updated = await this.prisma.hostXpRule.update({ where: { key }, data: { xpPerUnit, enabled: body.enabled !== false } });
    await this.audit.record({ actorId, actorRole: roles, action: 'host_xp_rule.update', targetType: 'host_xp_rule', targetId: key, metadata: { xpPerUnit, enabled: updated.enabled } });
    return updated;
  }
}
