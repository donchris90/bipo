import { CanActivate, ExecutionContext, Injectable, ForbiddenException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { RoleName } from '@prisma/client';
import { ROLES_KEY } from '../decorators/roles.decorator';

@Injectable()
export class RolesGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const requiredRoles = this.reflector.getAllAndOverride<RoleName[]>(ROLES_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);

    if (!requiredRoles || requiredRoles.length === 0) {
      return true; // no @Roles(...) on the route — JwtAuthGuard alone governs access
    }

    const request = context.switchToHttp().getRequest();
    const user = request.user; // populated by JwtStrategy.validate()

    if (!user || !Array.isArray(user.roles)) {
      throw new ForbiddenException('No role information on request');
    }

    const hasRole = requiredRoles.some((r) => user.roles.includes(r));
    if (!hasRole) {
      throw new ForbiddenException('Insufficient role for this action');
    }
    return true;
  }
}
