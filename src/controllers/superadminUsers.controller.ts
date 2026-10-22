import { randomInt } from 'crypto';
import { Request, Response } from 'express';
import bcrypt from 'bcryptjs';
import { Types } from 'mongoose';
import { User } from '../models/User';
import { Membership } from '../models/Membership';
import { ApiError } from '../utils/ApiError';
import { asyncHandler } from '../utils/asyncHandler';
import { logEvent } from '../services/systemLog';

/**
 * Lo que soporte hace con las cuentas de las personas: encontrarlas, corregir
 * su correo y darles una contraseña temporal cuando no pueden entrar.
 *
 * Cada acción queda en los logs con quién la hizo. La contraseña temporal no:
 * se muestra una sola vez a quien la generó y no se guarda en ningún lado.
 */

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

/** Sin letras que se confunden al dictarlas (0/O, 1/l/I). */
const ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789';

function temporaryPassword(length = 10) {
  let out = '';
  for (let i = 0; i < length; i += 1) out += ALPHABET.charAt(randomInt(ALPHABET.length));
  return out;
}

const escapeRegex = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

async function findUser(id: string) {
  if (!Types.ObjectId.isValid(id)) throw ApiError.notFound('Usuario no encontrado');
  const user = await User.findById(id);
  if (!user) throw ApiError.notFound('Usuario no encontrado');
  return user;
}

/** GET /superadmin/users?q= — busca por nombre o correo, con sus negocios. */
export const listUsers = asyncHandler(async (req: Request, res: Response) => {
  const q = String(req.query.q ?? '').trim();
  const filter = q
    ? { $or: [{ name: new RegExp(escapeRegex(q), 'i') }, { email: new RegExp(escapeRegex(q), 'i') }] }
    : {};

  const users = await User.find(filter)
    .select('name email isActive isSuperAdmin mustChangePassword passwordChangedAt createdAt')
    .sort({ createdAt: -1 })
    .limit(50)
    .lean();

  const memberships = await Membership.find({ user: { $in: users.map((u) => u._id) } })
    .populate<{ tenant: { _id: Types.ObjectId; name: string } | null }>('tenant', 'name')
    .select('user tenant role isActive')
    .lean();

  res.json({
    users: users.map((u) => ({
      ...u,
      tenants: memberships
        .filter((m) => m.user.toString() === u._id.toString() && m.tenant)
        .map((m) => ({ _id: m.tenant!._id, name: m.tenant!.name, role: m.role, isActive: m.isActive })),
    })),
  });
});

/** PATCH /superadmin/users/:id/email — corrige el correo con el que entra. */
export const changeUserEmail = asyncHandler(async (req: Request, res: Response) => {
  const user = await findUser(String(req.params.id));
  const email = String(req.body?.email ?? '').trim().toLowerCase();

  if (!EMAIL.test(email)) throw ApiError.badRequest('Ese correo no parece válido.');
  if (email === user.email) throw ApiError.badRequest('Ese ya es su correo.');

  const taken = await User.exists({ email, _id: { $ne: user._id } });
  if (taken) throw ApiError.conflict('Ese correo ya lo usa otra cuenta.');

  const previous = user.email;
  user.email = email;
  await user.save();

  logEvent({
    level: 'info',
    source: 'api',
    message: `Soporte cambió el correo de ${previous} a ${email}`,
    action: 'superadmin:user-email',
    user: String(user._id),
    context: { by: req.auth?.userId, previous, email },
  });

  res.json({ user: { _id: user._id, name: user.name, email: user.email } });
});

/**
 * POST /superadmin/users/:id/reset-password — genera una contraseña temporal.
 *
 * Al entrar con ella, el usuario tiene que elegir una propia antes de seguir.
 * Las sesiones que tenía abiertas se cierran: si alguien más tenía acceso a la
 * cuenta, lo pierde en ese momento.
 */
export const resetUserPassword = asyncHandler(async (req: Request, res: Response) => {
  const user = await findUser(String(req.params.id));
  const password = temporaryPassword();

  user.passwordHash = await bcrypt.hash(password, 10);
  user.mustChangePassword = true;
  user.passwordChangedAt = new Date();
  user.tokenVersion = (user.tokenVersion ?? 0) + 1;
  await user.save();

  logEvent({
    level: 'info',
    source: 'api',
    message: `Soporte generó una contraseña temporal para ${user.email}`,
    action: 'superadmin:user-reset-password',
    user: String(user._id),
    context: { by: req.auth?.userId },
  });

  // Única vez que viaja en claro: no se guarda ni se registra.
  res.json({ temporaryPassword: password, email: user.email, name: user.name });
});
