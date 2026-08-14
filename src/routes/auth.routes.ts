import { Router } from 'express';
import { login, refresh, register } from '../controllers/auth.controller';

export const authRoutes = Router();

authRoutes.post('/register', register);
authRoutes.post('/login', login);
authRoutes.post('/refresh', refresh);
