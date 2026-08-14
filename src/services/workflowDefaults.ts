import { Types } from 'mongoose';
import { WorkflowState } from '../models/WorkflowState';

export async function seedDefaultWorkflow(tenantId: Types.ObjectId) {
  // `icon` holds a name from the frontend icon registry (src/lib/icons.tsx).
  const fulfillmentStates = [
    { name: 'Recibido', color: '#0ea5e9', icon: 'inbox', position: 0, isInitial: true, isFinal: false, isCancellation: false },
    { name: 'En preparación', color: '#f59e0b', icon: 'package', position: 1, isInitial: false, isFinal: false, isCancellation: false },
    { name: 'Listo', color: '#10b981', icon: 'circle-check', position: 2, isInitial: false, isFinal: false, isCancellation: false },
    { name: 'Entregado', color: '#10b981', icon: 'house', position: 3, isInitial: false, isFinal: true, isCancellation: false },
    { name: 'Cancelado', color: '#ef4444', icon: 'circle-x', position: 4, isInitial: false, isFinal: true, isCancellation: true },
  ];

  const paymentStates = [
    { name: 'Pendiente', color: '#f59e0b', icon: 'hourglass', position: 0, isInitial: true, isFinal: false, isCancellation: false },
    { name: 'Parcial', color: '#0ea5e9', icon: 'coins', position: 1, isInitial: false, isFinal: false, isCancellation: false },
    { name: 'Pagado', color: '#10b981', icon: 'banknote', position: 2, isInitial: false, isFinal: true, isCancellation: false },
    { name: 'Reembolsado', color: '#ef4444', icon: 'undo-2', position: 3, isInitial: false, isFinal: true, isCancellation: true },
  ];

  const docs = [
    ...fulfillmentStates.map((s) => ({ ...s, tenant: tenantId, kind: 'fulfillment' as const })),
    ...paymentStates.map((s) => ({ ...s, tenant: tenantId, kind: 'payment' as const })),
  ];

  await WorkflowState.insertMany(docs);
}
