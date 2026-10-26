import type { FastifyReply, FastifyRequest } from 'fastify';
import type pg from 'pg';
import type { Actor } from './audit.js';
import type { Hub } from './events.js';

export type Role = 'calltaker' | 'dispatcher' | 'supervisor' | 'crew' | 'qa' | 'admin'
  | 'pharmacist' | 'technician' | 'ipc' | 'hr' | 'accountant' | 'director'
  /** Nhân viên bệnh viện nhận bệnh: chỉ vào các API ghi rõ vai trò này (cổng bệnh viện) */
  | 'hospital';

export interface TokenUser {
  id: string;
  username: string;
  name: string;
  role: Role;
  /** Vai trò bắt buộc xác thực hai lớp mà chưa cài: chỉ được vào các trang cài đặt */
  mfaSetup?: boolean;
  /** Vé tạm giữa bước mật khẩu và bước mã 6 số: không dùng làm phiên đăng nhập */
  typ?: 'mfa_challenge';
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

/** Phiên đăng nhập dùng được không: vé tạm của bước xác thực hai lớp thì không */
export const isSession = (u: Partial<TokenUser> | null | undefined) => !!u && !u.typ && !!u.role;

/** Nhật ký không ghi token đăng nhập (kết nối /ws?token=..., link ?token=...) ở dạng chữ rõ */
export const redactUrl = (url: string) => url.replace(/([?&](?:token|access_token|code)=)[^&]*/gi, '$1***');

const HOSPITAL_OPEN = ['/api/notifications'];

function check(roles: Role[], allowSetup: boolean) {
  return async (req: FastifyRequest, reply: FastifyReply) => {
    try {
      await req.jwtVerify();
    } catch {
      return reply.code(401).send({ error: 'Chưa đăng nhập hoặc phiên đã hết hạn' });
    }
    if (!isSession(req.user)) return reply.code(401).send({ error: 'Chưa đăng nhập hoặc phiên đã hết hạn' });
    if (req.user.mfaSetup && !allowSetup) {
      return reply.code(403).send({ error: 'Vai trò của bạn bắt buộc bật xác thực hai lớp: cài ứng dụng xác thực trước khi dùng phần mềm', details: { code: 'MFA_SETUP_REQUIRED' } });
    }
    // Tài khoản bệnh viện là người ngoài trung tâm: API "mọi người đăng nhập" không mở cho họ, trừ thông báo của chính họ
    if (req.user.role === 'hospital' && !roles.includes('hospital') && !(allowSetup || HOSPITAL_OPEN.some((p) => req.url.startsWith(p)))) {
      return reply.code(403).send({ error: 'Tài khoản bệnh viện không dùng được chức năng này' });
    }
    if (roles.length && !roles.includes(req.user.role)) {
      return reply.code(403).send({ error: 'Không có quyền thực hiện thao tác này' });
    }
  };
}

export const guard = (...roles: Role[]) => check(roles, false);
/** Cho cả phiên chưa cài xác thực hai lớp (trang cài đặt, thông tin của tôi) */
export const guardSetup = () => check([], true);

