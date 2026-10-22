import { Request, Response } from 'express';
import bcrypt from 'bcryptjs';
import { Types } from 'mongoose';
import { asyncHandler } from '../utils/asyncHandler';
import { ApiError } from '../utils/ApiError';
import { env, isEmailConfigured } from '../config/env';
import { Invitation, newInvitationToken } from '../models/Invitation';
import { Membership, MembershipRole } from '../models/Membership';
import { Tenant } from '../models/Tenant';
import { User } from '../models/User';
import { sessionFor } from './auth.controller';
import { invitationEmail, sendEmail } from '../services/email';
import { getEntitlements, limitOf } from '../services/entitlements';
import { isSharedBotConfigured, sendWhatsappMessage } from '../services/whatsapp';
import { logEvent } from '../services/systemLog';

const ROLES: MembershipRole[] = ['owner', 'admin', 'staff', 'driver'];

const ROLE_LABELS: Record<MembershipRole, string> = {
  owner: 'Dueño',
  admin: 'Administrador',
  staff: 'Personal',
  driver: 'Repartidor',
};

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const MIN_PASSWORD = 8;

function invitationUrl(token: string): string {
  return `${env.frontendUrl}/invite/${token}`;
}

/**
 * Cuántos lugares ocupa el negocio y cuántos le permite el plan.
 *
 * Las invitaciones pendientes cuentan como ocupadas. Si no contaran, un plan
 * de dos personas se esquiva mandando veinte invitaciones y esperando que las
 * acepten: el límite recién saltaría cuando ya no se puede deshacer.
 */
async function seatUsage(tenantId: string) {
  const [members, pending, ent] = await Promise.all([
    Membership.countDocuments({ tenant: tenantId, isActive: true }),
    Invitation.countDocuments({
      tenant: tenantId,
      status: 'pending',
      expiresAt: { $gt: new Date() },
    }),
    getEntitlements(tenantId),
  ]);

  const limit = limitOf(ent, 'maxMembers');
  const used = members + pending;

  return {
    members,
    pending,
    used,
    limit,
    /** 0 = ilimitado. */
    available: limit === 0 ? null : Math.max(0, limit - used),
    full: limit !== 0 && used >= limit,
  };
}

/**
 * Marca como vencidas las invitaciones que pasaron su fecha.
 *
 * Se hace al leer, no con un proceso aparte: no hay cron, y la única vez que
 * importa el estado de una invitación es cuando alguien la mira.
 */
async function expireStaleInvitations(tenantId: string) {
  await Invitation.updateMany(
    { tenant: tenantId, status: 'pending', expiresAt: { $lte: new Date() } },
    { $set: { status: 'expired' } },
  );
}

/** Un admin no puede tocar a un dueño: si no, se asciende solo. */
function assertCanActOn(actor: MembershipRole, targetRole: MembershipRole) {
  if (actor !== 'owner' && targetRole === 'owner') {
    throw ApiError.forbidden('Solo un dueño puede modificar a otro dueño');
  }
}

/** Solo un dueño reparte el rol de dueño. */
function assertCanGrant(actor: MembershipRole, role: MembershipRole) {
  if (role === 'owner' && actor !== 'owner') {
    throw ApiError.forbidden('Solo un dueño puede nombrar a otro dueño');
  }
}

/**
 * Impide que el negocio quede sin ningún dueño.
 *
 * Es la regla que no se puede olvidar: sin dueño nadie puede volver a tocar
 * los ajustes, el workflow ni el equipo, y recuperarlo sería entrar a la base
 * de datos a mano.
 */
async function assertNotLastOwner(tenantId: string, membershipId: Types.ObjectId) {
  const owners = await Membership.countDocuments({
    tenant: tenantId,
    role: 'owner',
    isActive: true,
    _id: { $ne: membershipId },
  });

  if (owners === 0) {
    throw ApiError.badRequest(
      'Es el único dueño del negocio. Nombra a otro dueño antes de quitarle el acceso.',
    );
  }
}

/* ════════════════════════ Equipo del negocio ════════════════════════ */

// GET /team
export const getTeam = asyncHandler(async (req: Request, res: Response) => {
  const tenantId = req.auth!.tenantId!;
  await expireStaleInvitations(tenantId);

  const [members, invitations, seats] = await Promise.all([
    Membership.find({ tenant: tenantId })
      .populate<{ user: { _id: Types.ObjectId; name: string; email: string; phone?: string } }>(
        'user',
        'name email phone',
      )
      .sort({ createdAt: 1 })
      .lean(),
    Invitation.find({ tenant: tenantId, status: 'pending' })
      .populate<{ invitedBy: { name: string } }>('invitedBy', 'name')
      .sort({ createdAt: -1 })
      .lean(),
    seatUsage(tenantId),
  ]);

  res.json({
    members: members.map((m) => ({
      _id: m._id,
      role: m.role,
      isActive: m.isActive,
      createdAt: m.createdAt,
      user: m.user,
      /** Para que el front no ofrezca acciones sobre uno mismo. */
      isMe: String((m.user as { _id?: unknown })?._id) === req.auth!.userId,
    })),
    invitations: invitations.map((i) => ({
      _id: i._id,
      email: i.email,
      role: i.role,
      phone: i.phone,
      expiresAt: i.expiresAt,
      createdAt: i.createdAt,
      invitedBy: i.invitedBy,
      // El dueño necesita el link para reenviarlo por donde quiera.
      url: invitationUrl(i.token),
    })),
    seats,
    /** Si no, el front promete un correo que nunca va a salir. */
    emailEnabled: isEmailConfigured(),
    roles: ROLES.map((role) => ({ value: role, label: ROLE_LABELS[role] })),
  });
});

// POST /team/invitations
export const inviteMember = asyncHandler(async (req: Request, res: Response) => {
  const tenantId = req.auth!.tenantId!;
  const actorRole = req.auth!.role as MembershipRole;

  const { email: rawEmail, role: rawRole, phone } = req.body as {
    email?: string;
    role?: MembershipRole;
    phone?: string;
  };

  const email = rawEmail?.trim().toLowerCase() ?? '';
  if (!EMAIL_PATTERN.test(email)) throw ApiError.badRequest('Escribe un correo válido');

  const role = rawRole && ROLES.includes(rawRole) ? rawRole : 'staff';
  assertCanGrant(actorRole, role);

  await expireStaleInvitations(tenantId);

  // Ya está adentro: invitarlo otra vez no haría nada y confunde.
  const existingUser = await User.findOne({ email });
  if (existingUser) {
    const membership = await Membership.findOne({ tenant: tenantId, user: existingUser._id });
    if (membership?.isActive) {
      throw ApiError.conflict(`${email} ya es parte del equipo`);
    }
  }

  const seats = await seatUsage(tenantId);
  if (seats.full) {
    throw ApiError.forbidden(
      `Tu plan permite ${seats.limit} persona(s) y ya tienes ${seats.used} entre miembros e invitaciones pendientes. Sube de plan o cancela una invitación.`,
    );
  }

  const expiresAt = new Date(Date.now() + env.invitationTtlDays * 24 * 60 * 60 * 1000);

  /**
   * Reinvitar al mismo correo reemplaza la invitación anterior en vez de sumar
   * otra: si no, quedan tres links vivos para la misma persona y cancelar uno
   * no cancela nada.
   */
  const invitation = await Invitation.findOneAndUpdate(
    { tenant: tenantId, email, status: 'pending' },
    {
      $set: {
        role,
        phone: phone?.replace(/\D/g, '') || undefined,
        token: newInvitationToken(),
        invitedBy: req.auth!.userId,
        expiresAt,
        status: 'pending',
      },
    },
    { new: true, upsert: true, runValidators: true },
  );

  const [tenant, inviter] = await Promise.all([
    Tenant.findById(tenantId).select('name phone').lean(),
    User.findById(req.auth!.userId).select('name').lean(),
  ]);

  const url = invitationUrl(invitation.token);

  const message = invitationEmail({
    businessName: tenant?.name ?? 'un negocio',
    inviterName: inviter?.name,
    role,
    acceptUrl: url,
    expiresAt,
    needsAccount: !existingUser,
  });

  const emailSent = await sendEmail(
    { ...message, to: email },
    { tenant: tenantId, action: 'team:invite' },
  );

  // Si dejó teléfono, además por WhatsApp: es por donde la gente mira.
  let whatsappSent = false;
  if (invitation.phone) {
    /*
     * Sale por el número de uTracker, no por el del negocio: es un mensaje
     * del sistema, y si el plan no incluye avisos la invitación igual tiene
     * que llegar.
     */
    whatsappSent = isSharedBotConfigured();
    void sendWhatsappMessage(
      invitation.phone,
      [
        `*${tenant?.name ?? 'Un negocio'}* te invitó a su equipo en uTracker`,
        '',
        `Entras como ${ROLE_LABELS[role]}.`,
        '',
        `Acepta aquí: ${url}`,
      ].join('\n'),
    );
  }

  logEvent({
    level: 'info',
    source: 'api',
    message: `Invitación al equipo para ${email} como ${role}`,
    action: 'team:invite',
    tenant: tenantId,
    user: req.auth!.userId,
    context: { email, role, emailSent, whatsappSent },
  });

  res.status(201).json({
    invitation: {
      _id: invitation._id,
      email: invitation.email,
      role: invitation.role,
      phone: invitation.phone,
      expiresAt: invitation.expiresAt,
      url,
    },
    emailSent,
    whatsappSent,
    /** El link siempre vuelve: si el correo no salió, es el plan B. */
    url,
  });
});

// DELETE /team/invitations/:id
export const cancelInvitation = asyncHandler(async (req: Request, res: Response) => {
  const invitation = await Invitation.findOne({
    _id: req.params.id,
    tenant: req.auth!.tenantId,
  });
  if (!invitation) throw ApiError.notFound('Invitación no encontrada');

  if (invitation.status === 'accepted') {
    throw ApiError.conflict('Esa invitación ya fue aceptada. Quita a la persona del equipo.');
  }

  invitation.status = 'cancelled';
  await invitation.save();

  res.json({ ok: true });
});

// PATCH /team/members/:id
export const updateMember = asyncHandler(async (req: Request, res: Response) => {
  const tenantId = req.auth!.tenantId!;
  const actorRole = req.auth!.role as MembershipRole;
  const { role, isActive } = req.body as { role?: MembershipRole; isActive?: boolean };

  const membership = await Membership.findOne({ _id: req.params.id, tenant: tenantId });
  if (!membership) throw ApiError.notFound('Miembro no encontrado');

  assertCanActOn(actorRole, membership.role);

  const isSelf = String(membership.user) === req.auth!.userId;

  if (role !== undefined) {
    if (!ROLES.includes(role)) throw ApiError.badRequest('Rol inválido');
    assertCanGrant(actorRole, role);

    // Bajarse el propio rol es perder el acceso con el que se está trabajando.
    if (isSelf && role !== membership.role) {
      throw ApiError.badRequest('No puedes cambiar tu propio rol. Pídeselo a otro dueño.');
    }
    if (membership.role === 'owner' && role !== 'owner') {
      await assertNotLastOwner(tenantId, membership._id);
    }
    membership.role = role;
  }

  if (isActive !== undefined) {
    if (isSelf && !isActive) throw ApiError.badRequest('No puedes desactivar tu propio acceso');
    if (!isActive && membership.role === 'owner') {
      await assertNotLastOwner(tenantId, membership._id);
    }
    membership.isActive = isActive;
  }

  await membership.save();
  await membership.populate('user', 'name email phone');

  res.json(membership);
});

// DELETE /team/members/:id
export const removeMember = asyncHandler(async (req: Request, res: Response) => {
  const tenantId = req.auth!.tenantId!;
  const actorRole = req.auth!.role as MembershipRole;

  const membership = await Membership.findOne({ _id: req.params.id, tenant: tenantId });
  if (!membership) throw ApiError.notFound('Miembro no encontrado');

  assertCanActOn(actorRole, membership.role);

  if (String(membership.user) === req.auth!.userId) {
    throw ApiError.badRequest('No puedes quitarte a ti mismo del equipo');
  }
  if (membership.role === 'owner') await assertNotLastOwner(tenantId, membership._id);

  await membership.deleteOne();

  logEvent({
    level: 'info',
    source: 'api',
    message: 'Miembro quitado del equipo',
    action: 'team:remove',
    tenant: tenantId,
    user: req.auth!.userId,
    context: { membershipId: String(membership._id), role: membership.role },
  });

  res.json({ ok: true });
});

/* ════════════════════════ Aceptar la invitación ════════════════════════ */

/** Carga la invitación por token, vigente, o explica por qué no sirve. */
async function loadPendingInvitation(token: string) {
  const invitation = await Invitation.findOne({ token: String(token) });
  if (!invitation) throw ApiError.notFound('Esta invitación no existe');

  if (invitation.status === 'accepted') {
    throw ApiError.conflict('Esta invitación ya fue usada. Entra con tu cuenta.');
  }
  if (invitation.status === 'cancelled') {
    throw ApiError.conflict('Esta invitación fue cancelada por el negocio.');
  }
  if (invitation.expiresAt.getTime() < Date.now()) {
    if (invitation.status === 'pending') {
      invitation.status = 'expired';
      await invitation.save();
    }
    throw ApiError.conflict('Esta invitación venció. Pídele al negocio que te manden otra.');
  }

  return invitation;
}

// GET /invitations/:token — público, lo abre el invitado.
export const getPublicInvitation = asyncHandler(async (req: Request, res: Response) => {
  const invitation = await loadPendingInvitation(String(req.params.token));

  const [tenant, inviter, user] = await Promise.all([
    Tenant.findById(invitation.tenant).select('name logoUrl').lean(),
    invitation.invitedBy ? User.findById(invitation.invitedBy).select('name').lean() : null,
    User.findOne({ email: invitation.email }).select('_id name').lean(),
  ]);

  res.json({
    business: { name: tenant?.name ?? 'el negocio', logoUrl: tenant?.logoUrl },
    email: invitation.email,
    role: invitation.role,
    roleLabel: ROLE_LABELS[invitation.role],
    invitedBy: inviter?.name ?? null,
    expiresAt: invitation.expiresAt,
    /** Si no tiene cuenta, el formulario pide nombre y contraseña nueva. */
    needsAccount: !user,
    name: user?.name ?? null,
  });
});

// POST /invitations/:token/accept — público.
export const acceptInvitation = asyncHandler(async (req: Request, res: Response) => {
  const invitation = await loadPendingInvitation(String(req.params.token));
  const { name, password } = req.body as { name?: string; password?: string };

  if (!password) throw ApiError.badRequest('Escribe tu contraseña');

  let user = await User.findOne({ email: invitation.email });

  if (user) {
    /**
     * Ya tiene cuenta: se le pide su contraseña.
     *
     * El token alcanza para saber a quién se invitó, pero no para probar que
     * quien lo abrió es esa persona. Sin este paso, un link reenviado por
     * error le daría acceso a quien lo reciba.
     */
    if (!(await user.comparePassword(password))) {
      throw ApiError.unauthorized('Esa no es tu contraseña de uTracker');
    }
  } else {
    if (!name?.trim()) throw ApiError.badRequest('Escribe tu nombre');
    if (password.length < MIN_PASSWORD) {
      throw ApiError.badRequest(`La contraseña necesita al menos ${MIN_PASSWORD} caracteres`);
    }

    user = await User.create({
      name: name.trim(),
      email: invitation.email,
      passwordHash: await bcrypt.hash(password, 10),
    });
  }

  // El límite se vuelve a revisar: entre la invitación y el clic pudo bajar de plan.
  const seats = await seatUsage(String(invitation.tenant));
  const alreadyMember = await Membership.findOne({ tenant: invitation.tenant, user: user._id });

  if (!alreadyMember && seats.limit !== 0 && seats.members >= seats.limit) {
    throw ApiError.forbidden(
      'El negocio llegó al límite de personas de su plan. Pídele al dueño que lo amplíe.',
    );
  }

  /**
   * Reactiva en vez de duplicar: el índice único de tenant+user lo impide, y
   * alguien que vuelve al negocio debería recuperar su acceso, no chocar.
   */
  if (alreadyMember) {
    alreadyMember.role = invitation.role;
    alreadyMember.isActive = true;
    await alreadyMember.save();
  } else {
    await Membership.create({ tenant: invitation.tenant, user: user._id, role: invitation.role });
  }

  invitation.status = 'accepted';
  invitation.acceptedAt = new Date();
  invitation.acceptedBy = user._id;
  await invitation.save();

  const tenant = await Tenant.findById(invitation.tenant).select('name slug logoUrl isActive').lean();

  logEvent({
    level: 'info',
    source: 'api',
    message: `${user.email} aceptó la invitación como ${invitation.role}`,
    action: 'team:accept',
    tenant: String(invitation.tenant),
    user: String(user._id),
  });

  // La misma sesión que el ingreso normal: con la versión de su contraseña.
  res.json({
    ...sessionFor(user),
    tenant: tenant ? { ...tenant, role: invitation.role } : null,
  });
});
