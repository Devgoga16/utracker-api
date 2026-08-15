import { Request, Response } from 'express';
import bcrypt from 'bcryptjs';
import { User } from '../models/User';
import { ApiError } from '../utils/ApiError';
import { asyncHandler } from '../utils/asyncHandler';
import { signAccessToken, signRefreshToken, verifyRefreshToken } from '../utils/jwt';

export const register = asyncHandler(async (req: Request, res: Response) => {
  const { name, email, password } = req.body as { name: string; email: string; password: string };
  if (!name || !email || !password) throw ApiError.badRequest('name, email and password are required');

  const existing = await User.findOne({ email: email.toLowerCase() });
  if (existing) throw ApiError.conflict('Email already registered');

  const passwordHash = await bcrypt.hash(password, 10);
  const user = await User.create({ name, email: email.toLowerCase(), passwordHash });

  res.status(201).json({
    user: { id: user._id, name: user.name, email: user.email, isSuperAdmin: user.isSuperAdmin },
    accessToken: signAccessToken(user._id.toString()),
    refreshToken: signRefreshToken(user._id.toString()),
  });
});

export const login = asyncHandler(async (req: Request, res: Response) => {
  const { email, password } = req.body as { email: string; password: string };
  if (!email || !password) throw ApiError.badRequest('email and password are required');

  const user = await User.findOne({ email: email.toLowerCase() });
  if (!user || !(await user.comparePassword(password))) {
    throw ApiError.unauthorized('Invalid credentials');
  }

  res.json({
    user: { id: user._id, name: user.name, email: user.email, isSuperAdmin: user.isSuperAdmin },
    accessToken: signAccessToken(user._id.toString()),
    refreshToken: signRefreshToken(user._id.toString()),
  });
});

export const refresh = asyncHandler(async (req: Request, res: Response) => {
  const { refreshToken } = req.body as { refreshToken: string };
  if (!refreshToken) throw ApiError.badRequest('refreshToken is required');

  try {
    const payload = verifyRefreshToken(refreshToken);
    res.json({ accessToken: signAccessToken(payload.sub) });
  } catch {
    throw ApiError.unauthorized('Invalid or expired refresh token');
  }
});
