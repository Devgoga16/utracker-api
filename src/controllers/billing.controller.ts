import { Request, Response } from 'express';
import { Types } from 'mongoose';
import { asyncHandler } from '../utils/asyncHandler';
import { ApiError } from '../utils/ApiError';
import { Bill } from '../models/Bill';
import { Subscription } from '../models/Subscription';
import { uploadImage } from '../services/storage';

// ─── Superadmin ───────────────────────────────────────────────────────────────

export const listAllBills = asyncHandler(async (_req: Request, res: Response) => {
  const bills = await Bill.find()
    .sort({ period: -1, createdAt: -1 })
    .populate('tenant', 'name slug')
    .lean();
  res.json({ bills, total: bills.length });
});

export const generateMonthlyBills = asyncHandler(async (req: Request, res: Response) => {
  const now = new Date();
  const period =
    (req.body.period as string | undefined) ??
    `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;

  if (!/^\d{4}-\d{2}$/.test(period)) {
    throw ApiError.badRequest('Formato de período inválido (YYYY-MM)');
  }
  const [year, month] = period.split('-').map(Number);

  const subs = await Subscription.find({ status: { $in: ['trial', 'active'] } })
    .populate('plan', 'name price')
    .lean();

  let created = 0;
  for (const sub of subs) {
    const plan = sub.plan as { name: string; price: number } | null;
    if (!plan || plan.price === 0) continue;
    const exists = await Bill.exists({ tenant: sub.tenant, period });
    if (exists) continue;
    // Last day of the billed month
    const dueDate = new Date(year, month, 0);
    await Bill.create({
      tenant: sub.tenant,
      subscription: sub._id,
      period,
      planName: plan.name,
      amount: plan.price,
      dueDate,
      status: 'pending',
    });
    created++;
  }

  res.json({ created, period });
});

export const updateBill = asyncHandler(async (req: Request, res: Response) => {
  const { status, notes } = req.body as { status?: string; notes?: string };
  const bill = await Bill.findById(req.params.id).populate('tenant', 'name');
  if (!bill) throw ApiError.notFound('Bill not found');

  if (status) bill.status = status as typeof bill.status;
  if (status === 'paid') {
    bill.paidAt = new Date();
    if (req.auth?.userId) bill.confirmedBy = new Types.ObjectId(req.auth.userId);
  }
  if (notes !== undefined) bill.notes = notes || undefined;

  await bill.save();
  res.json(bill);
});

// ─── Owner ────────────────────────────────────────────────────────────────────

export const getMyBills = asyncHandler(async (req: Request, res: Response) => {
  if (!req.auth?.tenantId) throw ApiError.unauthorized();
  const bills = await Bill.find({ tenant: req.auth.tenantId })
    .sort({ period: -1 })
    .lean();
  res.json(bills);
});

export const uploadProofFile = asyncHandler(async (req: Request, res: Response) => {
  if (!req.auth?.tenantId) throw ApiError.unauthorized();
  const file = req.file;
  if (!file) throw ApiError.badRequest('No se recibió ningún archivo');
  const uploaded = await uploadImage(file.buffer, req.auth.tenantId, 'billing-proof');
  res.json({ url: uploaded.url });
});

export const submitProof = asyncHandler(async (req: Request, res: Response) => {
  if (!req.auth?.tenantId) throw ApiError.unauthorized();
  const { proofImageUrl } = req.body as { proofImageUrl: string };
  if (!proofImageUrl) throw ApiError.badRequest('proofImageUrl es requerido');

  const bill = await Bill.findOne({ _id: req.params.id, tenant: req.auth.tenantId });
  if (!bill) throw ApiError.notFound('Factura no encontrada');
  if (!['pending', 'overdue'].includes(bill.status)) {
    throw ApiError.badRequest('Solo puedes subir comprobante para facturas pendientes o vencidas');
  }

  bill.proofImageUrl = proofImageUrl;
  bill.proofUploadedAt = new Date();
  bill.status = 'reviewing';
  await bill.save();
  res.json(bill);
});
