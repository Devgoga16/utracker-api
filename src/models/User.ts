import { Schema, model, Types } from 'mongoose';
import bcrypt from 'bcryptjs';

export interface IUser {
  _id: Types.ObjectId;
  name: string;
  email: string;
  passwordHash: string;
  phone?: string;
  isActive: boolean;
  isSuperAdmin: boolean;
  /**
   * La contraseña actual la puso el superadmin: al entrar con ella, el usuario
   * tiene que elegir una propia antes de hacer cualquier otra cosa.
   */
  mustChangePassword: boolean;
  /**
   * Sube cada vez que cambia la contraseña. Va dentro del refresh token: uno
   * emitido antes del cambio deja de servir, así un reseteo cierra las
   * sesiones que estaban abiertas.
   */
  tokenVersion: number;
  passwordChangedAt?: Date;
  createdAt: Date;
  updatedAt: Date;
  comparePassword(candidate: string): Promise<boolean>;
}

const userSchema = new Schema<IUser>(
  {
    name: { type: String, required: true, trim: true },
    email: { type: String, required: true, unique: true, lowercase: true, trim: true },
    passwordHash: { type: String, required: true },
    phone: { type: String },
    isActive: { type: Boolean, default: true },
    isSuperAdmin: { type: Boolean, default: false },
    mustChangePassword: { type: Boolean, default: false },
    tokenVersion: { type: Number, default: 0 },
    passwordChangedAt: { type: Date },
  },
  { timestamps: true }
);

userSchema.methods.comparePassword = function (candidate: string) {
  return bcrypt.compare(candidate, this.passwordHash);
};

export const User = model<IUser>('User', userSchema);
