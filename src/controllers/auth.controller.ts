import { Request, Response } from 'express';
import bcrypt from 'bcryptjs';
import { IUser, User } from '../models/User';
import { ApiError } from '../utils/ApiError';
import { asyncHandler } from '../utils/asyncHandler';
import { signAccessToken, signRefreshToken, verifyRefreshToken } from '../utils/jwt';

/** Lo que el panel sabe del usuario. `mustChangePassword` lo manda a crear su contraseña. */
export function publicUser(user: Pick<IUser, '_id' | 'name' | 'email' | 'isSuperAdmin' | 'mustChangePassword'>) {
  return {
    id: user._id,
    name: user.name,
    email: user.email,
    isSuperAdmin: user.isSuperAdmin,
    mustChangePassword: Boolean(user.mustChangePassword),
  };
}

/** Sesión nueva: el refresh lleva la versión de la contraseña para poder invalidarlo. */
export function sessionFor(user: IUser) {
  return {
    user: publicUser(user),
    accessToken: signAccessToken(user._id.toString()),
    refreshToken: signRefreshToken(user._id.toString(), user.tokenVersion ?? 0),
  };
}

const MIN_PASSWORD = 8;

export const register = asyncHandler(async (req: Request, res: Response) => {
  const { name, email, password } = req.body as { name: string; email: string; password: string };
  if (!name || !email || !password) throw ApiError.badRequest('name, email and password are required');

  const existing = await User.findOne({ email: email.toLowerCase() });
  if (existing) throw ApiError.conflict('Email already registered');

  const passwordHash = await bcrypt.hash(password, 10);
  const user = await User.create({ name, email: email.toLowerCase(), passwordHash });

  res.status(201).json(sessionFor(user));
});

export const login = asyncHandler(async (req: Request, res: Response) => {
  const { email, password } = req.body as { email: string; password: string };
  if (!email || !password) throw ApiError.badRequest('email and password are required');

  const user = await User.findOne({ email: email.toLowerCase().trim() });
  if (!user || !(await user.comparePassword(password))) {
    throw ApiError.unauthorized('Invalid credentials');
  }

  res.json(sessionFor(user));
});

export const refresh = asyncHandler(async (req: Request, res: Response) => {
  const { refreshToken } = req.body as { refreshToken: string };
  if (!refreshToken) throw ApiError.badRequest('refreshToken is required');

  let payload;
  try {
    payload = verifyRefreshToken(refreshToken);
  } catch {
    throw ApiError.unauthorized('Invalid or expired refresh token');
  }

  /*
   * Un refresh emitido antes del último cambio de contraseña ya no sirve: así
   * una contraseña reseteada por soporte cierra las sesiones que estaban
   * abiertas. Los tokens de antes de este cambio no traen versión y valen
   * como 0, que es la versión de toda cuenta a la que nunca se le cambió.
   */
  const user = await User.findById(payload.sub).select('tokenVersion isActive').lean();
  if (!user || user.isActive === false || (payload.v ?? 0) !== (user.tokenVersion ?? 0)) {
    throw ApiError.unauthorized('Tu sesión se cerró. Vuelve a ingresar.');
  }

  res.json({ accessToken: signAccessToken(payload.sub) });
});

/**
 * POST /auth/password — el usuario elige una contraseña nueva.
 *
 * Si la actual la generó el superadmin (`mustChangePassword`), no se pide:
 * acaba de entrar con ella. Si no, se pide, como en cualquier sistema.
 * Al cambiarla se cierran las demás sesiones y se devuelve una nueva.
 */
export const changePassword = asyncHandler(async (req: Request, res: Response) => {
  if (!req.auth?.userId) throw ApiError.unauthorized();
  const { currentPassword, newPassword } = req.body as { currentPassword?: string; newPassword?: string };

  const user = await User.findById(req.auth.userId);
  if (!user) throw ApiError.unauthorized();

  if (!newPassword || newPassword.length < MIN_PASSWORD) {
    throw ApiError.badRequest(`La contraseña nueva debe tener al menos ${MIN_PASSWORD} caracteres.`);
  }
  if (!user.mustChangePassword) {
    if (!currentPassword || !(await user.comparePassword(currentPassword))) {
      throw ApiError.badRequest('La contraseña actual no es correcta.');
    }
  }
  if (await user.comparePassword(newPassword)) {
    throw ApiError.badRequest('Elige una contraseña distinta a la que tienes ahora.');
  }

  user.passwordHash = await bcrypt.hash(newPassword, 10);
  user.mustChangePassword = false;
  user.passwordChangedAt = new Date();
  user.tokenVersion = (user.tokenVersion ?? 0) + 1;
  await user.save();

  res.json(sessionFor(user));
});
