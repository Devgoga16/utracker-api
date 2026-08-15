import { Request, Response } from 'express';
import { WorkflowState, WorkflowKind } from '../models/WorkflowState';
import { Order } from '../models/Order';
import { MembershipRole } from '../models/Membership';
import { ApiError } from '../utils/ApiError';
import { asyncHandler } from '../utils/asyncHandler';

function parseKind(value: unknown): WorkflowKind {
  if (value !== 'fulfillment' && value !== 'payment') {
    throw ApiError.badRequest("kind debe ser 'fulfillment' o 'payment'");
  }
  return value;
}

export const createState = asyncHandler(async (req: Request, res: Response) => {
  if (!req.auth?.tenantId) throw ApiError.unauthorized();
  const tenantId = req.auth.tenantId;

  const { kind: rawKind, name, color, icon, notifyCustomer, deductsStock, allowedRoles } = req.body as {
    kind: unknown;
    name?: string;
    color?: string;
    icon?: string;
    notifyCustomer?: boolean;
    deductsStock?: boolean;
    allowedRoles?: MembershipRole[];
  };

  const kind = parseKind(rawKind);
  if (!name?.trim()) throw ApiError.badRequest('El nombre es obligatorio');

  const last = await WorkflowState.findOne({ tenant: tenantId, kind }).sort({ position: -1 });

  const state = await WorkflowState.create({
    tenant: tenantId,
    kind,
    name: name.trim(),
    color: color ?? '#64748b',
    icon,
    position: (last?.position ?? -1) + 1,
    isInitial: false,
    isFinal: false,
    isCancellation: false,
    notifyCustomer: notifyCustomer ?? false,
    deductsStock: kind === 'fulfillment' ? (deductsStock ?? false) : false,
    allowedRoles: allowedRoles?.length ? allowedRoles : ['owner', 'admin'],
  });

  res.status(201).json({ state });
});

export const updateState = asyncHandler(async (req: Request, res: Response) => {
  if (!req.auth?.tenantId) throw ApiError.unauthorized();
  const tenantId = req.auth.tenantId;

  const state = await WorkflowState.findOne({ _id: req.params.id, tenant: tenantId });
  if (!state) throw ApiError.notFound('Estado no encontrado');

  const { name, color, icon, isInitial, isFinal, notifyCustomer, vibrant, requiresLink, deductsStock, allowedRoles } = req.body as {
    name?: string;
    color?: string;
    icon?: string;
    isInitial?: boolean;
    isFinal?: boolean;
    notifyCustomer?: boolean;
    vibrant?: boolean;
    requiresLink?: boolean;
    deductsStock?: boolean;
    allowedRoles?: MembershipRole[];
  };

  if (name !== undefined) {
    if (!name.trim()) throw ApiError.badRequest('El nombre no puede quedar vacío');
    state.name = name.trim();
  }
  if (color !== undefined) state.color = color;
  if (icon !== undefined) state.icon = icon;
  if (notifyCustomer !== undefined) state.notifyCustomer = notifyCustomer;
  if (vibrant !== undefined) state.vibrant = vibrant;
  if (requiresLink !== undefined) state.requiresLink = requiresLink;
  if (deductsStock !== undefined) state.deductsStock = state.kind === 'fulfillment' ? deductsStock : false;
  if (allowedRoles !== undefined) {
    if (!allowedRoles.length) throw ApiError.badRequest('Al menos un rol debe poder mover el pedido a este estado');
    state.allowedRoles = allowedRoles;
  }

  // Exactly one initial state per kind: promoting one demotes the previous.
  if (isInitial === true && !state.isInitial) {
    await WorkflowState.updateMany(
      { tenant: tenantId, kind: state.kind, _id: { $ne: state._id } },
      { $set: { isInitial: false } }
    );
    state.isInitial = true;
  } else if (isInitial === false && state.isInitial) {
    throw ApiError.badRequest('Marcá otro estado como inicial en lugar de desmarcar este');
  }

  if (isFinal !== undefined) {
    if (state.isCancellation && isFinal === false) {
      throw ApiError.badRequest('El estado de cancelación siempre es final');
    }
    state.isFinal = isFinal;
  }

  await state.save();
  res.json({ state });
});

export const deleteState = asyncHandler(async (req: Request, res: Response) => {
  if (!req.auth?.tenantId) throw ApiError.unauthorized();
  const tenantId = req.auth.tenantId;

  const state = await WorkflowState.findOne({ _id: req.params.id, tenant: tenantId });
  if (!state) throw ApiError.notFound('Estado no encontrado');

  if (state.isCancellation) {
    throw ApiError.conflict('El estado de cancelación no se puede eliminar');
  }
  if (state.isInitial) {
    throw ApiError.conflict('No podés eliminar el estado inicial. Marcá otro como inicial primero.');
  }

  // Orders sitting in this state would be left pointing at nothing.
  const field = state.kind === 'fulfillment' ? 'fulfillmentState' : 'paymentState';
  const inUse = await Order.countDocuments({ tenant: tenantId, [field]: state._id });
  if (inUse > 0) {
    throw ApiError.conflict(
      `Hay ${inUse} pedido(s) en este estado. Movelos a otro estado antes de eliminarlo.`
    );
  }

  await state.deleteOne();

  // Close the gap so positions stay contiguous.
  await WorkflowState.updateMany(
    { tenant: tenantId, kind: state.kind, position: { $gt: state.position } },
    { $inc: { position: -1 } }
  );

  res.status(204).send();
});

export const reorderStates = asyncHandler(async (req: Request, res: Response) => {
  if (!req.auth?.tenantId) throw ApiError.unauthorized();
  const tenantId = req.auth.tenantId;

  const { kind: rawKind, orderedIds } = req.body as { kind: unknown; orderedIds?: string[] };
  const kind = parseKind(rawKind);
  if (!Array.isArray(orderedIds) || !orderedIds.length) {
    throw ApiError.badRequest('orderedIds es obligatorio');
  }

  const states = await WorkflowState.find({ tenant: tenantId, kind });
  if (states.length !== orderedIds.length) {
    throw ApiError.badRequest('orderedIds debe incluir todos los estados de este workflow');
  }

  const known = new Set(states.map((s) => s._id.toString()));
  if (!orderedIds.every((id) => known.has(id))) {
    throw ApiError.badRequest('orderedIds contiene un estado que no pertenece a este workflow');
  }

  await Promise.all(
    orderedIds.map((id, position) =>
      WorkflowState.updateOne({ _id: id, tenant: tenantId }, { $set: { position } })
    )
  );

  const updated = await WorkflowState.find({ tenant: tenantId, kind }).sort({ position: 1 });
  res.json({ states: updated });
});
