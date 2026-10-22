import { Router } from 'express';
import { changePassword, login, refresh, register } from '../controllers/auth.controller';
import { requireAuth } from '../middleware/auth';

export const authRoutes = Router();

authRoutes.post('/register', register);
authRoutes.post('/login', login);
authRoutes.post('/refresh', refresh);
// Elegir contraseña nueva; obligatorio tras una temporal del superadmin.
authRoutes.post('/password', requireAuth, changePassword);
