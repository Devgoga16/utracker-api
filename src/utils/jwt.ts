import jwt from 'jsonwebtoken';
import { env } from '../config/env';

export interface AccessTokenPayload {
  sub: string; // userId
}

export interface RefreshTokenPayload extends AccessTokenPayload {
  /** La versión de la contraseña con que se emitió. Ver `User.tokenVersion`. */
  v?: number;
}

export function signAccessToken(userId: string): string {
  return jwt.sign({ sub: userId } as AccessTokenPayload, env.jwt.accessSecret, {
    expiresIn: env.jwt.accessExpiresIn,
  } as jwt.SignOptions);
}

export function signRefreshToken(userId: string, version = 0): string {
  return jwt.sign({ sub: userId, v: version } as RefreshTokenPayload, env.jwt.refreshSecret, {
    expiresIn: env.jwt.refreshExpiresIn,
  } as jwt.SignOptions);
}

export function verifyAccessToken(token: string): AccessTokenPayload {
  return jwt.verify(token, env.jwt.accessSecret) as AccessTokenPayload;
}

export function verifyRefreshToken(token: string): RefreshTokenPayload {
  return jwt.verify(token, env.jwt.refreshSecret) as RefreshTokenPayload;
}
