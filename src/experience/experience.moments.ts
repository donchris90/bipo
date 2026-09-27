import { PrismaService } from '../prisma/prisma.service';

export async function createMoment(prisma: PrismaService, input: { userId: string; type: string; title: string; description?: string; payload?: any }) {
  return prisma.rrydaMoment.create({ data: { userId: input.userId, type: input.type.slice(0, 40), title: input.title.slice(0, 160), description: input.description?.slice(0, 500), payload: input.payload ?? undefined } });
}
