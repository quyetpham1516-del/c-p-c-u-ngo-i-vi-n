import type { FastifyReply, FastifyRequest } from 'fastify';
import type pg from 'pg';
import type { Actor } from './audit.js';
import type { Hub } from './events.js';

export type Role = 'calltaker' | 'dispatcher' | 'supervisor' | 'crew' | 'qa' | 'admin'
  | 'pharmacist' | 'technician' | 'ipc' | 'hr' | 'accountant' | 'director';

export interface TokenUser {
  id: string;
  username: string;
  name: string;
  role: Role;
}

declare module '@fastify/jwt' {
  interface FastifyJWT {
    payload: TokenUser;
    user: TokenUser;
  }
}

export interface Ctx {
  pool: pg.Pool;
  hub: Hub;
}

export const EOC_ROLES: Role[] = ['calltaker', 'dispatcher', 'supervisor', 'admin'];
export const DISPATCH_ROLES: Role[] = ['dispatcher', 'supervisor', 'admin'];
export const REVIEW_ROLES: Role[] = ['supervisor', 'qa', 'admin'];

export function actorOf(req: FastifyRequest): Actor {
  return { id: req.user.id, name: req.user.name };
}

export function guard(...roles: Role[]) {
  return async (req: FastifyRequest, reply: FastifyReply) => {
    try {
      await req.jwtVerify();
    } catch {
      return reply.code(401).send({ error: 'Chưa đăng nhập hoặc phiên đã hết hạn' });
    }
    if (roles.length && !roles.includes(req.user.role)) {
      return reply.code(403).send({ error: 'Không có quyền thực hiện thao tác này' });
    }
  };
}

